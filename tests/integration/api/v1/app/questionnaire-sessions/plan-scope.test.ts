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
  recordAiRun: vi.fn(async () => undefined),
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
function session(over: { answers?: string[]; fills?: string[] } = {}) {
  return {
    versionId: 'v1',
    interviewPlan: null,
    version: { goal: 'find the constraint', config: { conditionalTopics: { enabled: true } } },
    dataSlotFills: (over.fills ?? []).map((key) => ({
      confidence: 0.9,
      value: 'said something',
      paraphrase: null,
      provisional: false,
      provenanceLabel: 'direct',
      dataSlot: { key },
    })),
    answers: (over.answers ?? []).map((key) => ({
      value: null,
      paraphrase: `what they said about ${key}`,
      questionSlot: { key, prompt: `the question behind ${key}?` },
    })),
    _count: { turns: 1 },
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
    expect(mocks.prisma.appQuestionSlot.findMany).not.toHaveBeenCalled();
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
