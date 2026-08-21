/**
 * Interviewer-policy analytics — the pure aggregator.
 *
 * Covers the three things this surface has to get right, all of which are easy to get subtly wrong:
 * the arc is counted per SESSION (not per turn), a turn with no recorded phase is reported rather
 * than folded into `open`, and a finding is silent below the evidence floor.
 *
 * @see lib/app/questionnaire/analytics/interviewer-policy.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyTurns = vi.fn();
const findUniqueVersion = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireTurn: { findMany: (...a: unknown[]) => findManyTurns(...a) },
    appQuestionnaireVersion: { findUnique: (...a: unknown[]) => findUniqueVersion(...a) },
  },
}));

import {
  assembleInterviewerPolicyAnalytics,
  getInterviewerPolicyAnalytics,
  POLICY_TURN_READ_CAP,
  POLICY_FINDING_MIN_SESSIONS,
  type PolicyMustAskQuestion,
  type PolicyTurnRow,
  type PolicyVersionFacts,
} from '@/lib/app/questionnaire/analytics/interviewer-policy';

const RANGE = { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' };
const META = { versionId: 'ver-1', range: RANGE };

const FACTS: PolicyVersionFacts = {
  arcConfigured: true,
  fidelityGateOn: true,
  houseRulesActive: 2,
};

function turn(over: Partial<PolicyTurnRow> = {}): PolicyTurnRow {
  return {
    sessionId: 's1',
    ordinal: 1,
    funnelPhase: 'open',
    targetedQuestionKey: null,
    questionCardKey: null,
    ...over,
  };
}

/** N sessions that each reached `phase`, so a finding's evidence floor can be crossed. */
function sessionsAt(phase: string, count: number): PolicyTurnRow[] {
  return Array.from({ length: count }, (_, i) => turn({ sessionId: `s${i}`, funnelPhase: phase }));
}

const assemble = (
  turns: PolicyTurnRow[],
  mustAsk: PolicyMustAskQuestion[] = [],
  facts: PolicyVersionFacts = FACTS
) => assembleInterviewerPolicyAnalytics(turns, mustAsk, facts, META);

describe('assembleInterviewerPolicyAnalytics — the arc', () => {
  it('counts a session once, by the furthest phase it reached', () => {
    // A twenty-turn interview that got to `targeted` must not outweigh a five-turn one that got
    // just as far. The arc is a property of a conversation, not of a turn.
    const out = assemble([
      turn({ sessionId: 'a', ordinal: 1, funnelPhase: 'open' }),
      turn({ sessionId: 'a', ordinal: 2, funnelPhase: 'mixed' }),
      turn({ sessionId: 'a', ordinal: 3, funnelPhase: 'targeted' }),
      turn({ sessionId: 'b', ordinal: 1, funnelPhase: 'open' }),
    ]);
    expect(out.sessions).toBe(2);
    expect(out.furthestPhase).toEqual({ open: 1, mixed: 0, targeted: 1 });
  });

  it('does not regress a session that dips back toward open', () => {
    // A terse answer steps the phase toward targeted and a rich one can step it back, so the
    // sequence is not monotonic. "Furthest" has to mean furthest, not last.
    const out = assemble([
      turn({ sessionId: 'a', ordinal: 1, funnelPhase: 'targeted' }),
      turn({ sessionId: 'a', ordinal: 2, funnelPhase: 'open' }),
    ]);
    expect(out.furthestPhase.targeted).toBe(1);
    expect(out.furthestPhase.open).toBe(0);
  });

  it('reports turns with no recorded phase instead of counting them as open', () => {
    // Turns written before the column exists are unknown, not broad. Folding them into `open`
    // would invent a narrative out of missing data.
    const out = assemble([
      turn({ sessionId: 'a', funnelPhase: null }),
      turn({ sessionId: 'b', funnelPhase: 'mixed' }),
    ]);
    expect(out.turnsWithoutPhase).toBe(1);
    expect(out.sessions).toBe(1);
    expect(out.furthestPhase.open).toBe(0);
  });

  it('ignores a phase string it does not recognise', () => {
    const out = assemble([turn({ funnelPhase: 'sideways' })]);
    expect(out.turnsWithoutPhase).toBe(1);
    expect(out.sessions).toBe(0);
  });

  it('takes the earliest targeted turn per session for the median', () => {
    const out = assemble([
      turn({ sessionId: 'a', ordinal: 9, funnelPhase: 'targeted' }),
      turn({ sessionId: 'a', ordinal: 4, funnelPhase: 'targeted' }),
      turn({ sessionId: 'b', ordinal: 6, funnelPhase: 'targeted' }),
    ]);
    expect(out.medianTurnsToTargeted).toBe(5);
  });

  it('reports no median when no session ever got specific', () => {
    expect(assemble([turn({ funnelPhase: 'open' })]).medianTurnsToTargeted).toBeNull();
  });
});

describe('assembleInterviewerPolicyAnalytics — must-ask questions', () => {
  const mustAsk: PolicyMustAskQuestion[] = [
    { key: 'q1', prompt: 'How satisfied are you?' },
    { key: 'q2', prompt: 'Describe a recent problem.' },
  ];

  it('counts reach and card rendering per question', () => {
    const out = assemble(
      [
        turn({ sessionId: 'a', targetedQuestionKey: 'q1', questionCardKey: 'q1' }),
        turn({ sessionId: 'b', targetedQuestionKey: 'q1' }),
      ],
      mustAsk
    );
    const [q1, q2] = out.mustAsk;
    expect(q1).toMatchObject({ key: 'q1', reached: 2, cardShown: 1 });
    // A question no turn targeted is reported at zero, not omitted — the zero is the finding.
    expect(q2).toMatchObject({ key: 'q2', reached: 0, cardShown: 0 });
  });

  it('keeps reach and card count separate', () => {
    // The card is emitted only for a TYPED must-ask, so a free-text one correctly reaches without
    // one. A gap between the two is a prompt to look, never a fault — so they never merge.
    const out = assemble([turn({ targetedQuestionKey: 'q2' })], mustAsk);
    expect(out.mustAsk[1]).toMatchObject({ reached: 1, cardShown: 0 });
  });
});

describe('assembleInterviewerPolicyAnalytics — findings', () => {
  const enough = POLICY_FINDING_MIN_SESSIONS;

  it('says nothing at all below the evidence floor', () => {
    // A policy judged on three interviews is a guess.
    const out = assemble(sessionsAt('open', enough - 1), [{ key: 'q1', prompt: 'Never asked' }]);
    expect(out.findings).toEqual([]);
  });

  it('reports an arc that never narrowed once there is enough evidence', () => {
    const out = assemble(sessionsAt('open', enough));
    expect(out.findings.map((f) => f.code)).toContain('arc_never_narrowed');
    // The count is in the message so the reader can weigh it.
    expect(out.findings[0].message).toContain(String(enough));
  });

  it('stays quiet about the arc when the questionnaire does not use a funnel', () => {
    // An `open` approach is SUPPOSED to stay open. Reporting that as a failure would be the
    // surface arguing with a correct decision.
    const out = assemble(sessionsAt('open', enough), [], { ...FACTS, arcConfigured: false });
    expect(out.findings.map((f) => f.code)).not.toContain('arc_never_narrowed');
  });

  it('stays quiet when at least one session did narrow', () => {
    const turns = [
      ...sessionsAt('open', enough),
      turn({ sessionId: 'z', funnelPhase: 'targeted' }),
    ];
    expect(assemble(turns).findings.map((f) => f.code)).not.toContain('arc_never_narrowed');
  });

  it('reports a must-ask question no interview ever reached', () => {
    const out = assemble(sessionsAt('targeted', enough), [{ key: 'q1', prompt: 'Never asked' }]);
    const finding = out.findings.find((f) => f.code === 'must_ask_never_reached');
    expect(finding?.questionKey).toBe('q1');
    expect(finding?.message).toContain('Never asked');
  });

  it('does not report one that was reached', () => {
    const turns = sessionsAt('targeted', enough).map((t) => ({
      ...t,
      targetedQuestionKey: 'q1',
    }));
    expect(assemble(turns, [{ key: 'q1', prompt: 'Asked' }]).findings).toEqual([]);
  });
});

describe('assembleInterviewerPolicyAnalytics — what it does not claim', () => {
  it('reports house rules as a configuration count, carried through untouched', () => {
    // There is no per-turn record of a rule firing. This is the version's configuration, and the
    // panel says so — a behavioural count inferred from prompt text would be a guess with a number
    // attached.
    expect(assemble([turn()], [], { ...FACTS, houseRulesActive: 3 }).houseRulesActive).toBe(3);
  });

  it('carries the gate flags so the reader knows what the numbers mean', () => {
    const out = assemble([turn()], [], { ...FACTS, fidelityGateOn: false, arcConfigured: false });
    expect(out.fidelityGateOn).toBe(false);
    expect(out.arcConfigured).toBe(false);
  });
});

/**
 * The Prisma seam. Mirrors `routing.test.ts`'s shape — the read shape and the k-anonymity carve-out
 * are the two things a mistake here would silently get wrong.
 */
describe('getInterviewerPolicyAnalytics', () => {
  const scope = {
    versionId: 'v1',
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-09-01T00:00:00.000Z'),
    tagIds: [] as string[],
  };

  function turnRows(n: number, phase = 'targeted') {
    return Array.from({ length: n }, (_, i) => ({
      sessionId: `s${i}`,
      ordinal: 1,
      funnelPhase: phase,
      questionCardKey: null,
      targetedQuestionId: null,
    }));
  }

  const versionRow = (over: Record<string, unknown> = {}) => ({
    config: {
      interviewerStrategy: { enabled: true, approach: 'funnel' },
      questionFidelity: { enabled: true, defaultFidelity: 0.5 },
      houseRules: {
        enabled: true,
        rules: [{ id: 'r1', kind: 'never', enabled: true, text: 'Never use humour.' }],
      },
      ...(over.config as object),
    },
    sections: over.sections ?? [{ questions: [] }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueVersion.mockResolvedValue(versionRow());
  });

  it('reads only non-preview turns in the window', async () => {
    findManyTurns.mockResolvedValue(turnRows(POLICY_FINDING_MIN_SESSIONS));
    await getInterviewerPolicyAnalytics(scope);
    expect(findManyTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          session: expect.objectContaining({ versionId: 'v1', isPreview: false }),
          createdAt: { gte: scope.from, lt: scope.to },
        }),
      })
    );
  });

  it('detects truncation by reading one past the cap', async () => {
    // One over is how truncation is spotted without paying for a second count query.
    findManyTurns.mockResolvedValue(turnRows(POLICY_TURN_READ_CAP + 1));
    const out = await getInterviewerPolicyAnalytics(scope);
    expect(out.truncated).toBe(true);
    expect(findManyTurns).toHaveBeenCalledWith(
      expect.objectContaining({ take: POLICY_TURN_READ_CAP + 1 })
    );
  });

  it('withholds detail on a cohort below the k-anonymity threshold, but keeps the count', async () => {
    // The same carve-out `getRoutingAnalytics` makes: `sessions` stays so the surface can say how
    // far off the threshold it is, while everything that could describe an individual is zeroed.
    findManyTurns.mockResolvedValue(turnRows(2));
    const out = await getInterviewerPolicyAnalytics(scope);
    expect(out.suppressed).toBe(true);
    expect(out.sessions).toBe(2);
    expect(out.furthestPhase).toEqual({ open: 0, mixed: 0, targeted: 0 });
    expect(out.mustAsk).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it('reads the arc only for a funnel — open and targeted have no arc to narrow', async () => {
    findManyTurns.mockResolvedValue(turnRows(POLICY_FINDING_MIN_SESSIONS));
    findUniqueVersion.mockResolvedValue(
      versionRow({ config: { interviewerStrategy: { enabled: true, approach: 'open' } } })
    );
    expect((await getInterviewerPolicyAnalytics(scope)).arcConfigured).toBe(false);
  });

  it('counts only rules that are switched on', async () => {
    findManyTurns.mockResolvedValue(turnRows(POLICY_FINDING_MIN_SESSIONS));
    findUniqueVersion.mockResolvedValue(
      versionRow({
        config: {
          houseRules: {
            enabled: true,
            rules: [
              { id: 'r1', kind: 'never', enabled: true, text: 'In force.' },
              { id: 'r2', kind: 'always', enabled: false, text: 'A parked draft.' },
            ],
          },
        },
      })
    );
    expect((await getInterviewerPolicyAnalytics(scope)).houseRulesActive).toBe(1);
  });

  it('resolves must-ask questions through the gate, not the raw column', async () => {
    // A slider pre-set before the feature was switched on is not a must-ask question.
    findManyTurns.mockResolvedValue(turnRows(POLICY_FINDING_MIN_SESSIONS));
    findUniqueVersion.mockResolvedValue(
      versionRow({
        config: { questionFidelity: { enabled: false, defaultFidelity: 0.5 } },
        sections: [{ questions: [{ id: 'id1', key: 'q1', prompt: 'P', fidelity: 1 }] }],
      })
    );
    expect((await getInterviewerPolicyAnalytics(scope)).mustAsk).toEqual([]);
  });

  it('maps a turn’s question id to its stable key', async () => {
    // The turn stores a row id; every reader downstream works in keys.
    findManyTurns.mockResolvedValue([
      ...turnRows(POLICY_FINDING_MIN_SESSIONS),
      {
        sessionId: 'sX',
        ordinal: 1,
        funnelPhase: 'targeted',
        questionCardKey: 'q1',
        targetedQuestionId: 'id1',
      },
    ]);
    findUniqueVersion.mockResolvedValue(
      versionRow({
        sections: [{ questions: [{ id: 'id1', key: 'q1', prompt: 'P', fidelity: 1 }] }],
      })
    );
    const out = await getInterviewerPolicyAnalytics(scope);
    expect(out.mustAsk[0]).toMatchObject({ key: 'q1', reached: 1, cardShown: 1 });
  });

  it('degrades to defaults when the version has no config row', async () => {
    findManyTurns.mockResolvedValue(turnRows(POLICY_FINDING_MIN_SESSIONS));
    findUniqueVersion.mockResolvedValue(null);
    const out = await getInterviewerPolicyAnalytics(scope);
    expect(out.houseRulesActive).toBe(0);
    expect(out.fidelityGateOn).toBe(false);
  });
});
