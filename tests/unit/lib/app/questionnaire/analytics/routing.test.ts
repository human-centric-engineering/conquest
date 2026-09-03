/**
 * Unit test: routing quality aggregation (F17.16).
 *
 * Two halves. `assembleRoutingAnalytics` is pure, so the counting rules — above all "a respondent's
 * correction is never a planner success" — are asserted directly against plan fixtures. The loader
 * is then tested for the query shape and the k-anonymity suppression it applies on top.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManySessions = vi.fn();
const loadTopicsMock = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-routes', () => ({
  loadTopics: (...a: unknown[]) => loadTopicsMock(...a),
}));

import {
  assembleRoutingAnalytics,
  getRoutingAnalytics,
  ROUTING_FINDING_MIN_PLANS,
} from '@/lib/app/questionnaire/analytics/routing';
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  InterviewPlan,
  PlannedTopic,
  ScopeDecisionSource,
  Topic,
  TopicPhase,
} from '@/lib/app/questionnaire/scope/types';

const META = { versionId: 'v1', range: { from: 'a', to: 'b' } };

function topic(key: string, phase: TopicPhase = 'conditional'): Topic {
  return {
    id: `id-${key}`,
    key,
    label: `Topic ${key}`,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [] },
    ordinal: 0,
    source: 'manual',
    trigger: null,
  };
}

function planned(key: string, source: ScopeDecisionSource = 'llm'): PlannedTopic {
  return { key, depth: 'full', source, rationale: '' };
}

function plan(overrides: Partial<InterviewPlan> = {}): InterviewPlan {
  return {
    v: 1,
    topics: [],
    excluded: [],
    checkTopicKey: null,
    confidence: 0.8,
    source: 'llm',
    respondentMessage: '',
    decidedAtTurn: 3,
    decidedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** N identical plans — enough to clear the finding threshold. */
function repeat(p: InterviewPlan, n = ROUTING_FINDING_MIN_PLANS): InterviewPlan[] {
  return Array.from({ length: n }, () => p);
}

function rowFor(result: ReturnType<typeof assembleRoutingAnalytics>, key: string) {
  return result.topics.find((t) => t.key === key);
}

describe('assembleRoutingAnalytics — counting rules', () => {
  it('never counts a respondent amendment as a planner selection', () => {
    // The invariant the whole feature rests on: counting a correction as a success would make a
    // version's criteria look better the worse they got.
    const result = assembleRoutingAnalytics(
      [
        plan({
          topics: [planned('a'), planned('b', 'respondent')],
          amendments: [
            { key: 'b', label: 'Topic b', request: 'can we cover b', atTurn: 5, at: 'x' },
          ],
        }),
      ],
      [topic('a'), topic('b')],
      META
    );

    expect(rowFor(result, 'a')).toMatchObject({ selected: 1, amended: 0 });
    expect(rowFor(result, 'b')).toMatchObject({ selected: 0, amended: 1 });
    expect(result.amendedPlans).toBe(1);
  });

  it('reads an amendment from the source tag alone, for plans written before amendments shipped', () => {
    const result = assembleRoutingAnalytics(
      [plan({ topics: [planned('b', 'respondent')] })],
      [topic('b')],
      META
    );

    expect(rowFor(result, 'b')).toMatchObject({ selected: 0, amended: 1 });
  });

  it('counts a topic recorded in both places only once', () => {
    const result = assembleRoutingAnalytics(
      [
        plan({
          topics: [planned('b', 'respondent')],
          amendments: [{ key: 'b', label: 'Topic b', request: 'q', atTurn: 5, at: 'x' }],
        }),
      ],
      [topic('b')],
      META
    );

    expect(rowFor(result, 'b')?.amended).toBe(1);
    expect(result.amendedPlans).toBe(1);
  });

  it('splits selections by the layer that decided them', () => {
    const result = assembleRoutingAnalytics(
      [plan({ topics: [planned('a', 'llm')] }), plan({ topics: [planned('a', 'llm')] })],
      [topic('a')],
      META
    );

    expect(rowFor(result, 'a')).toMatchObject({ selected: 2, chosen: 2, chosenRate: 1 });
    expect(rowFor(result, 'a')?.bySource).toMatchObject({ llm: 2, fallback: 0 });
  });

  it('never counts an area chosen during the opening as a planner success', () => {
    // F17.36, and the same rule an amendment follows. An early seat the full planner would also
    // have chosen is a success; one it would not have chosen is not, and folding them together
    // would make the criteria look better the harder the early-seating floor was tuned.
    const result = assembleRoutingAnalytics(
      [plan({ topics: [planned('a', 'early'), planned('b', 'llm')] })],
      [topic('a'), topic('b')],
      META
    );

    expect(rowFor(result, 'a')).toMatchObject({ selected: 1, chosen: 0, sampled: 0 });
    expect(rowFor(result, 'a')?.bySource).toMatchObject({ early: 1, llm: 0 });
    expect(rowFor(result, 'b')).toMatchObject({ chosen: 1 });
    expect(result.earlySeatedPlans).toBe(1);
  });

  it('counts a plan that chose two areas early as ONE plan that decided during its opening', () => {
    // The per-topic rows already say which areas; this count answers how often an opening decided
    // anything at all before it finished.
    const result = assembleRoutingAnalytics(
      [
        plan({ topics: [planned('a', 'early'), planned('b', 'early')] }),
        plan({ topics: [planned('a', 'llm')] }),
      ],
      [topic('a'), topic('b')],
      META
    );

    expect(result.earlySeatedPlans).toBe(1);
    expect(result.plans).toBe(2);
  });

  it('separates a budget drop from an ordinary exclusion', () => {
    const result = assembleRoutingAnalytics(
      [
        plan({
          excluded: [
            { key: 'a', source: 'budget', rationale: '' },
            { key: 'b', source: 'llm', rationale: '' },
          ],
        }),
      ],
      [topic('a'), topic('b')],
      META
    );

    expect(rowFor(result, 'a')).toMatchObject({ excluded: 1, droppedByBudget: 1 });
    expect(rowFor(result, 'b')).toMatchObject({ excluded: 1, droppedByBudget: 0 });
  });

  it('gives every conditional topic a row even when no plan ever mentioned it', () => {
    // The whole point of the "never fires" finding: a topic absent from every plan cannot be
    // discovered from the plans.
    const result = assembleRoutingAnalytics(
      [plan({ topics: [planned('a')] })],
      [topic('a'), topic('ghost')],
      META
    );

    expect(rowFor(result, 'ghost')).toMatchObject({ selected: 0, excluded: 0, amended: 0 });
  });

  it('labels a topic deleted since the plan was made, rather than hiding it', () => {
    const result = assembleRoutingAnalytics([plan({ topics: [planned('gone')] })], [], META);

    expect(rowFor(result, 'gone')).toMatchObject({ key: 'gone', label: 'gone', phase: null });
  });

  it('summarises the plans themselves', () => {
    const result = assembleRoutingAnalytics(
      [
        plan({ source: 'fallback', confidence: 0.4, checkTopicKey: 'c' }),
        plan({ source: 'llm', confidence: 0.8 }),
      ],
      [],
      META
    );

    expect(result).toMatchObject({ plans: 2, fallbackPlans: 1, checkTopicPlans: 1 });
    expect(result.meanConfidence).toBeCloseTo(0.6);
  });

  it('reports zeroes rather than dividing by zero on an empty cohort', () => {
    const result = assembleRoutingAnalytics([], [topic('a')], META);
    expect(result).toMatchObject({ plans: 0, meanConfidence: 0, findings: [] });
    expect(rowFor(result, 'a')?.chosenRate).toBe(0);
  });
});

describe('assembleRoutingAnalytics — the blind-spot check is not a selection', () => {
  // `chooseCheckTopic` is deterministic — author preference, else the FIRST unselected conditional
  // topic in authored order — and the check defaults on. So one topic is sampled in nearly every
  // plan, and reading that as selection would silence the finding it most needs to raise.
  const sampledEveryTime = plan({ topics: [planned('a'), planned('dormant', 'check')] });

  it('counts a check seating as sampled, never as chosen', () => {
    const result = assembleRoutingAnalytics(
      [sampledEveryTime],
      [topic('a'), topic('dormant')],
      META
    );

    expect(rowFor(result, 'dormant')).toMatchObject({ selected: 1, chosen: 0, sampled: 1 });
    expect(rowFor(result, 'dormant')?.chosenRate).toBe(0);
  });

  it('still reports a topic that only ever appears as the blind-spot check as never firing', () => {
    const result = assembleRoutingAnalytics(
      repeat(sampledEveryTime),
      [topic('a'), topic('dormant')],
      META
    );

    const finding = result.findings.find((f) => f.topicKey === 'dormant');
    expect(finding?.code).toBe('criteria_never_fires');
    // And it says why the topic nonetheless showed up in interviews, so the author is not left
    // holding two facts that look contradictory.
    expect(finding?.message).toContain('blind-spot check');
  });

  it('does not call a check-sampled topic an always-ask one', () => {
    // The regression this guards: counting the check as selection made `chosen === plans` true and
    // advised promoting a topic whose criteria never matched to a full-depth always-run topic.
    const result = assembleRoutingAnalytics(
      repeat(sampledEveryTime),
      [topic('a'), topic('dormant')],
      META
    );

    expect(
      result.findings.filter((f) => f.topicKey === 'dormant').map((f) => f.code)
    ).not.toContain('criteria_always_fires');
  });

  it('does not count a fallback seating as the criteria firing either', () => {
    const result = assembleRoutingAnalytics(
      [plan({ source: 'fallback', topics: [planned('a', 'fallback')] })],
      [topic('a')],
      META
    );

    expect(rowFor(result, 'a')).toMatchObject({ selected: 1, chosen: 0, sampled: 0 });
  });
});

describe('assembleRoutingAnalytics — findings', () => {
  it('says nothing at all below the sample threshold', () => {
    const result = assembleRoutingAnalytics(
      repeat(plan({ topics: [] }), ROUTING_FINDING_MIN_PLANS - 1),
      [topic('a')],
      META
    );

    expect(result.findings).toEqual([]);
  });

  it('reports a criteria sentence that never fires', () => {
    const result = assembleRoutingAnalytics(
      repeat(plan({ topics: [planned('a')] })),
      [topic('a'), topic('never')],
      META
    );

    const finding = result.findings.find((f) => f.topicKey === 'never');
    expect(finding?.code).toBe('criteria_never_fires');
    expect(finding?.message).toContain(`${ROUTING_FINDING_MIN_PLANS} interviews`);
  });

  it('does not call a topic dormant when respondents keep asking for it', () => {
    // It fires — just not from the criteria. Reporting "never included" alongside "respondents keep
    // adding it" would be two contradictory readings of the same rows.
    const amended = plan({
      topics: [planned('a', 'respondent')],
      amendments: [{ key: 'a', label: 'Topic a', request: 'q', atTurn: 2, at: 'x' }],
    });
    const result = assembleRoutingAnalytics(repeat(amended), [topic('a')], META);

    expect(result.findings.map((f) => f.code)).not.toContain('criteria_never_fires');
    expect(result.findings.map((f) => f.code)).toContain('respondents_keep_adding');
  });

  it('reports a conditional topic that is really an always-ask one', () => {
    const result = assembleRoutingAnalytics(
      repeat(plan({ topics: [planned('a')] })),
      [topic('a')],
      META
    );

    const finding = result.findings.find((f) => f.topicKey === 'a');
    expect(finding?.code).toBe('criteria_always_fires');
    expect(finding?.message).toContain('Always ask');
  });

  it('reports when the time budget, not the criteria, is deciding', () => {
    const dropped = plan({ excluded: [{ key: 'a', source: 'budget', rationale: '' }] });
    const result = assembleRoutingAnalytics(repeat(dropped), [topic('a')], META);

    expect(result.findings.map((f) => f.code)).toContain('budget_decides');
  });

  it('stays silent about always-run topics, which have no criteria to be wrong', () => {
    const result = assembleRoutingAnalytics(
      repeat(plan({ topics: [] })),
      [topic('spine', 'core')],
      META
    );

    expect(result.findings).toEqual([]);
  });

  it('stays silent about a topic that no longer exists, which cannot be edited', () => {
    const result = assembleRoutingAnalytics(repeat(plan({ topics: [planned('gone')] })), [], META);

    expect(result.findings).toEqual([]);
  });

  it('treats a single amendment as a one-off rather than a pattern', () => {
    const plans = [
      ...repeat(plan({ topics: [planned('a')] }), ROUTING_FINDING_MIN_PLANS),
      plan({
        topics: [planned('b', 'respondent')],
        amendments: [{ key: 'b', label: 'Topic b', request: 'q', atTurn: 2, at: 'x' }],
      }),
    ];
    const result = assembleRoutingAnalytics(plans, [topic('a'), topic('b')], META);

    expect(result.findings.map((f) => f.code)).not.toContain('respondents_keep_adding');
  });
});

describe('getRoutingAnalytics', () => {
  const scope: AnalyticsScope = {
    versionId: 'v1',
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-02-01T00:00:00.000Z'),
    tagIds: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadTopicsMock.mockResolvedValue([topic('a')]);
  });

  function planRows(n: number) {
    return Array.from({ length: n }, () => ({
      interviewPlan: { ...plan({ topics: [planned('a')] }) },
    }));
  }

  it('reads only non-preview sessions in the window', async () => {
    findManySessions.mockResolvedValue(planRows(K_ANONYMITY_THRESHOLD));
    await getRoutingAnalytics(scope);

    expect(findManySessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          versionId: 'v1',
          isPreview: false,
          createdAt: { gte: scope.from, lt: scope.to },
        }),
      })
    );
  });

  it('withholds per-topic detail on a cohort below the k-anonymity threshold', async () => {
    findManySessions.mockResolvedValue(planRows(K_ANONYMITY_THRESHOLD - 1));
    const result = await getRoutingAnalytics(scope);

    expect(result.suppressed).toBe(true);
    expect(result.topics).toEqual([]);
    expect(result.findings).toEqual([]);
    // The cohort size itself stays visible so the surface can say how far off the threshold it is.
    expect(result.plans).toBe(K_ANONYMITY_THRESHOLD - 1);
  });

  it('surfaces the detail once the cohort is large enough', async () => {
    findManySessions.mockResolvedValue(planRows(K_ANONYMITY_THRESHOLD));
    const result = await getRoutingAnalytics(scope);

    expect(result.suppressed).toBe(false);
    expect(result.topics).toHaveLength(1);
  });

  it('ignores a session that never reached a plan', async () => {
    // The "has a plan" filter is applied after narrowing rather than in the `where`, so a planless
    // session must not inflate the denominator every rate is computed against.
    findManySessions.mockResolvedValue([
      ...planRows(K_ANONYMITY_THRESHOLD),
      { interviewPlan: null },
    ]);
    const result = await getRoutingAnalytics(scope);

    expect(result.plans).toBe(K_ANONYMITY_THRESHOLD);
    expect(result.topics[0]?.chosenRate).toBe(1);
  });

  it('drops a plan blob that no longer narrows rather than guessing at it', async () => {
    findManySessions.mockResolvedValue([
      ...planRows(K_ANONYMITY_THRESHOLD),
      { interviewPlan: 'nonsense' },
    ]);
    const result = await getRoutingAnalytics(scope);

    expect(result.plans).toBe(K_ANONYMITY_THRESHOLD);
  });
});
