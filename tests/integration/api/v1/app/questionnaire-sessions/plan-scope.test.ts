/**
 * Integration test: the Scope Planner trigger, and the opening gate it enforces.
 *
 * `isOpeningComplete` is unit-tested beside the planner; what this file protects is the WIRING —
 * that the trigger actually hands the session's answered questions to the gate. The gate can be
 * perfectly correct and still never fire if the caller does not tell it what has been answered,
 * and the symptom of that is not an error: it is a plan decided on turn one, on an empty
 * transcript, with every `not_exists` hard rule matching because absence is what a veto tests for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn(), updateMany: vi.fn() },
    appQuestionnaireTopic: { findMany: vi.fn() },
    appQuestionSlot: { findMany: vi.fn() },
    appDataSlot: { findMany: vi.fn() },
  },
  planScope: vi.fn(),
  recordAiRun: vi.fn(async (_input: { detail: Record<string, unknown> }) => undefined),
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: mocks.recordAiRun }));
vi.mock('@/lib/app/questionnaire/scope/planner', async (importOriginal) => ({
  // `isOpeningComplete` stays REAL — it is the thing under test. Only the model call is replaced.
  ...(await importOriginal<typeof import('@/lib/app/questionnaire/scope/planner')>()),
  planScope: mocks.planScope,
}));

import { maybePlanScope } from '@/app/api/v1/app/questionnaire-sessions/_lib/plan-scope';

type TopicRow = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  phase: string;
  criteria: string | null;
  depth: string;
  members: { dataSlotKeys: string[]; questionKeys: string[] };
  ordinal: number;
  source: string;
};

function topicRow(
  key: string,
  phase: string,
  members: Partial<TopicRow['members']> = {}
): TopicRow {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [], ...members },
    ordinal: 0,
    source: 'seeded',
  };
}

/** A session whose opening is a question-only topic — the shape the old gate mis-read. */
function session(
  over: {
    answers?: string[];
    fills?: string[];
    /** Slots the orchestrator gave up on and parked with a synthesised `provisional` fill. */
    parkedFills?: string[];
    turns?: number;
    settings?: Record<string, unknown>;
    earlySeatedTopics?: unknown;
  } = {}
) {
  return {
    versionId: 'v1',
    interviewPlan: null,
    earlySeatedTopics: over.earlySeatedTopics ?? null,
    version: {
      goal: 'find the constraint',
      config: { conditionalTopics: { enabled: true, ...over.settings } },
    },
    dataSlotFills: [
      ...(over.fills ?? []).map((key) => ({
        confidence: 0.9,
        value: 'said something',
        paraphrase: null,
        provisional: false,
        provenanceLabel: 'direct',
        dataSlot: { key },
      })),
      ...(over.parkedFills ?? []).map((key) => ({
        confidence: 0.2,
        value: 'best guess',
        paraphrase: null,
        provisional: true,
        provenanceLabel: 'inferred',
        dataSlot: { key },
      })),
    ],
    answers: (over.answers ?? []).map((key) => ({
      value: null,
      paraphrase: `what they said about ${key}`,
      questionSlot: { key, prompt: `the question behind ${key}?` },
    })),
    _count: { turns: over.turns ?? 1 },
  };
}

const PLAN = {
  topics: [],
  excluded: [],
  source: 'llm' as const,
  confidence: 1,
  decidedAtTurn: 1,
  decidedAt: '2026-08-13T00:00:00.000Z',
  respondentMessage: '',
  checkTopicKey: null,
  amendments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planScope.mockResolvedValue({
    plan: PLAN,
    costUsd: 0,
    provider: null,
    model: null,
    promptSnapshot: null,
    outputSnapshot: null,
  });
  mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
    topicRow('open', 'opening', { questionKeys: ['q1', 'q2'] }),
    topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
  ]);
  mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
    { key: 'q1' },
    { key: 'q2' },
    { key: 'p1' },
  ]);
  mocks.prisma.appDataSlot.findMany.mockResolvedValue([]);
});

describe('maybePlanScope — the opening gate', () => {
  it('does not plan while an opening question is still unanswered', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(session({ answers: ['q1'] }));

    const result = await maybePlanScope('s1');

    expect(result).toEqual({ kind: 'skipped', reason: 'opening still in progress' });
    expect(mocks.planScope).not.toHaveBeenCalled();
    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
  });

  it('plans once every opening question has an answer', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'] })
    );

    const result = await maybePlanScope('s1');

    expect(result.kind).toBe('planned');
    expect(mocks.planScope).toHaveBeenCalledTimes(1);
  });

  it('is not held open by an opening member whose question was deleted', async () => {
    // `gone` resolves to nothing, so it can never be answered. Waiting for it would strand every
    // interview of this version in its opening forever.
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { questionKeys: ['q1', 'gone'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(session({ answers: ['q1'] }));

    expect((await maybePlanScope('s1')).kind).toBe('planned');
  });

  it('requires the data slots too — an answered question does not excuse an empty slot', async () => {
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { questionKeys: ['q1'], dataSlotKeys: ['situation'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(session({ answers: ['q1'] }));

    expect(await maybePlanScope('s1')).toEqual({
      kind: 'skipped',
      reason: 'opening still in progress',
    });

    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1'], fills: ['situation'] })
    );
    expect((await maybePlanScope('s1')).kind).toBe('planned');
  });

  it('does not query the version questions when no opening topic names any', async () => {
    // The ordinary adaptive session runs this trigger on every turn until it plans; the extra
    // lookup exists for the question-only opening and must not be charged to everyone else.
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { dataSlotKeys: ['situation'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ fills: ['situation'] })
    );

    expect((await maybePlanScope('s1')).kind).toBe('planned');

    // The opening-gate lookup reads the WHOLE version's keys. The other question query on this path
    // (F17.29's item prompts, keyed `in` the conditional topics' members) runs once, after the gate
    // has passed — so it is matched out here rather than asserting "no query at all", which would
    // have made this test fail for the wrong reason.
    const gateLookups = mocks.prisma.appQuestionSlot.findMany.mock.calls.filter((call) => {
      const args = call[0] as { where?: { key?: unknown } } | undefined;
      return args?.where?.key === undefined;
    });
    expect(gateLookups).toHaveLength(0);
  });

  it('does not price the planner’s item prompts until the opening gate has passed', async () => {
    // This trigger runs on EVERY turn until it plans. Reading what each conditional topic's
    // questions ask is worth one query per session and nothing per turn.
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { dataSlotKeys: ['situation'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(session({ fills: [] }));

    expect(await maybePlanScope('s1')).toEqual({
      kind: 'skipped',
      reason: 'opening still in progress',
    });
    expect(mocks.prisma.appQuestionSlot.findMany).not.toHaveBeenCalled();
  });

  it('hands the planner what each conditional topic’s questions ask', async () => {
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { dataSlotKeys: ['situation'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ fills: ['situation'] })
    );
    mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'p1', prompt: 'How long does approval take?' },
    ]);

    await maybePlanScope('s1');

    const passed = mocks.planScope.mock.calls[0][0] as {
      itemPrompts?: ReadonlyMap<string, string>;
    };
    expect(passed.itemPrompts?.get('p1')).toBe('How long does approval take?');
  });
});

describe('maybePlanScope — the evidence it hands the planner', () => {
  it("passes the respondent's answers through, not only the extracted fills", async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'] })
    );

    await maybePlanScope('s1');

    const passed = mocks.planScope.mock.calls[0][0];
    expect(passed.answers).toEqual([
      {
        key: 'q1',
        prompt: 'the question behind q1?',
        value: null,
        paraphrase: 'what they said about q1',
      },
      {
        key: 'q2',
        prompt: 'the question behind q2?',
        value: null,
        paraphrase: 'what they said about q2',
      },
    ]);
  });

  it('orders the opening answers first, so a large core topic cannot crowd them out', async () => {
    // The prompt is capped. The opening is what the plan is a judgement about, so it goes first.
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { questionKeys: ['q1'] }),
      topicRow('spine', 'core', { questionKeys: ['c1', 'c2'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'q1' },
      { key: 'c1' },
      { key: 'c2' },
      { key: 'p1' },
    ]);
    // The core answers land first in DB order; the opening answer must still lead.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['c1', 'c2', 'q1'] })
    );

    await maybePlanScope('s1');

    const passed = mocks.planScope.mock.calls[0][0];
    expect(passed.answers.map((a: { key: string }) => a.key)).toEqual(['q1', 'c1', 'c2']);
  });
});

/**
 * The time budget (C7b). The fit itself is unit-tested in `guardrails.test.ts`; what this protects
 * is the wiring — that the trigger PRICES the version and hands the planner the numbers. A fit
 * stage that never receives costs does not fail, it simply never fires, and the symptom is an
 * instrument that quietly ignores the budget its author set.
 */
describe('maybePlanScope — the time budget', () => {
  /** A session whose version sets a budget. */
  function budgeted(seconds: number) {
    return {
      ...session({ answers: ['q1', 'q2'] }),
      version: {
        goal: 'find the constraint',
        config: { conditionalTopics: { enabled: true, sessionBudgetSeconds: seconds } },
      },
    };
  }

  it('prices the version and hands the planner the budget', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(budgeted(600));
    mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'q1', type: 'free_text', typeConfig: null, weight: 1 },
      { key: 'q2', type: 'free_text', typeConfig: null, weight: 1 },
      { key: 'p1', type: 'likert', typeConfig: null, weight: 1 },
    ]);

    await maybePlanScope('s1');

    const passed = mocks.planScope.mock.calls[0][0];
    expect(passed.budget.budgetSeconds).toBe(600);
    // The opening's two free-text questions at 45s; the conditional topic's single likert at 8s.
    expect(passed.budget.costs.get('open')?.full).toBe(90);
    expect(passed.budget.costs.get('pipeline')?.full).toBe(8);
  });

  it('prices a matrix per row, so a grid does not read as one question', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(budgeted(600));
    mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'q1', type: 'free_text', typeConfig: null, weight: 1 },
      { key: 'q2', type: 'free_text', typeConfig: null, weight: 1 },
      {
        key: 'p1',
        type: 'matrix',
        typeConfig: {
          rows: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
            { key: 'c', label: 'C' },
          ],
          scale: { min: 1, max: 5, minLabel: 'Never', maxLabel: 'Always' },
        },
        weight: 1,
      },
    ]);

    await maybePlanScope('s1');

    expect(mocks.planScope.mock.calls[0][0].budget.costs.get('pipeline')?.full).toBe(24);
  });

  it('loads nothing extra for a version with no budget — the default', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'] })
    );

    await maybePlanScope('s1');

    expect(mocks.planScope.mock.calls[0][0].budget).toBeUndefined();
    expect(mocks.prisma.appDataSlot.findMany).not.toHaveBeenCalled();
  });
});

describe('maybePlanScope — the opening turn backstop (F17.36)', () => {
  /** The stall shape: an opening member no respondent can ever cover. */
  function stalled(over: { turns?: number; settings?: Record<string, unknown> } = {}) {
    return session({ answers: ['q1'], ...over });
  }

  it('does not fire below the limit', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      stalled({ turns: 8, settings: { maxOpeningTurns: 12 } })
    );

    expect(await maybePlanScope('s1')).toEqual({
      kind: 'skipped',
      reason: 'opening still in progress',
    });
    expect(mocks.planScope).not.toHaveBeenCalled();
  });

  it('never fires while the setting is 0, however many turns have passed', async () => {
    // 0 is "no limit", not "close immediately". Getting this backwards would close every opening
    // on its first turn, on every version that never asked for this.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(stalled({ turns: 400 }));

    expect(await maybePlanScope('s1')).toEqual({
      kind: 'skipped',
      reason: 'opening still in progress',
    });
  });

  it('closes the opening at the limit and plans on what there is', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      stalled({ turns: 12, settings: { maxOpeningTurns: 12 } })
    );

    const result = await maybePlanScope('s1');

    expect(result.kind).toBe('planned');
    expect(mocks.planScope).toHaveBeenCalledTimes(1);
  });

  it('records the turn, the limit and what was never covered', async () => {
    // A forced plan and a considered one are identical in `topics`. Without this record an admin
    // holding a thin report cannot tell that the interview decided early rather than decided badly.
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { questionKeys: ['q1', 'q2'], dataSlotKeys: ['routing'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      stalled({ turns: 15, settings: { maxOpeningTurns: 12 } })
    );

    const result = await maybePlanScope('s1');

    expect(result.kind).toBe('planned');
    if (result.kind !== 'planned') return;
    expect(result.plan.forcedClose).toEqual({
      atTurn: 15,
      limitTurns: 12,
      uncovered: { dataSlotKeys: ['routing'], questionKeys: ['q2'] },
    });

    // And it is what was written, not only what was returned.
    const written = mocks.prisma.appQuestionnaireSession.updateMany.mock.calls[0]?.[0] as {
      data: { interviewPlan: { forcedClose?: unknown } };
    };
    expect(written.data.interviewPlan.forcedClose).toEqual(result.plan.forcedClose);
  });

  it('leaves no forcedClose on a plan whose opening simply finished', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'], turns: 30, settings: { maxOpeningTurns: 12 } })
    );

    const result = await maybePlanScope('s1');

    expect(result.kind).toBe('planned');
    if (result.kind !== 'planned') return;
    expect(result.plan.forcedClose).toBeUndefined();
  });

  it('still counts a parked data slot as covered, so parking is not undone by this', async () => {
    // The orchestrator parks a slot it has given up re-asking, and that park is what stops a vague
    // answer holding the interview open. The gate must keep honouring it — the early-seating floor
    // is the reader that will not.
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
      topicRow('open', 'opening', { questionKeys: ['q1'], dataSlotKeys: ['situation'] }),
      topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
    ]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1'], parkedFills: ['situation'], turns: 2 })
    );

    const result = await maybePlanScope('s1');

    expect(result.kind).toBe('planned');
    if (result.kind !== 'planned') return;
    expect(result.plan.forcedClose).toBeUndefined();
  });
});

describe('maybePlanScope — absorbing early seats (F17.36)', () => {
  const early = {
    v: 1,
    seated: [
      {
        key: 'pipeline',
        depth: 'full',
        confidence: 0.93,
        rationale: 'seated early',
        respondentReason: 'you mentioned it',
        atTurn: 3,
      },
    ],
    deferred: [],
    lastPassAtTurn: 3,
    evidenceKey: 'e',
    overCap: false,
  };

  it('hands the seated topics to the planner as pre-seated', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'], earlySeatedTopics: early })
    );

    await maybePlanScope('s1');

    const params = mocks.planScope.mock.calls[0]?.[0] as {
      preSeated?: Array<{ key: string }>;
    };
    expect(params.preSeated?.map((s) => s.key)).toEqual(['pipeline']);
  });

  it('passes nothing when the session seated nothing early, which is nearly all of them', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'] })
    );

    await maybePlanScope('s1');

    const params = mocks.planScope.mock.calls[0]?.[0] as { preSeated?: unknown };
    expect(params.preSeated).toBeUndefined();
  });

  it('records which topics were already committed to on the audit row', async () => {
    // Without it the audit row cannot tell a planner choice from a ratified one, which is the
    // difference between "the agent chose this" and "the interview had already asked about it".
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'], earlySeatedTopics: early })
    );

    await maybePlanScope('s1');

    const run = mocks.recordAiRun.mock.calls[0]?.[0];
    expect(run?.detail.preSeatedKeys).toEqual(['pipeline']);
  });

  it('ignores an unreadable early-seating blob rather than failing the plan', async () => {
    // Null means "nothing was seated early", which resolves to the plan alone — exactly the
    // pre-F17.36 behaviour, and the safe direction for a record whose absence costs nothing.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'], earlySeatedTopics: { v: 99, seated: 'nonsense' } })
    );

    const result = await maybePlanScope('s1');

    expect(result.kind).toBe('planned');
    const params = mocks.planScope.mock.calls[0]?.[0] as { preSeated?: unknown };
    expect(params.preSeated).toBeUndefined();
  });
});
