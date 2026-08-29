/**
 * Integration test: re-reading the conversation when the interview grows (F17.33 phase B).
 *
 * The selection rules are unit-tested beside the pure module. What this file protects is the
 * WIRING, and three facts about it that no pure test can reach:
 *
 *  - **The ledger is written even when nothing is found** — otherwise every remaining turn pays to
 *    rediscover that there was nothing to find.
 *  - **The ledger is NOT written when the call fails** — a bad minute for the provider must not
 *    permanently cost the session its re-read.
 *  - **An already-answered question is never offered**, so it can never be overwritten.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn(), update: vi.fn() },
    appQuestionnaireTopic: { findMany: vi.fn() },
    appQuestionSlot: { findMany: vi.fn() },
    appDataSlot: { findMany: vi.fn() },
    appAnswerSlot: { findMany: vi.fn() },
    appDataSlotFill: { findMany: vi.fn() },
    appQuestionnaireTurn: { findMany: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
  runStructuredCompletion: vi.fn(),
  upsertAnswerSlot: vi.fn(
    async (_sessionId: string, _questionSlotId: string, _answer: Record<string, unknown>) =>
      'answer-row'
  ),
  upsertDataSlotFill: vi.fn(async () => ({ id: 'fill-row', changed: true })),
  reconcileChatDataSlotFills: vi.fn(async () => []),
  logCost: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: mocks.runStructuredCompletion,
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(async () => ({ slug: 'openai' })),
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  })),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: mocks.logCost }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/answer-slots', () => ({
  upsertAnswerSlot: mocks.upsertAnswerSlot,
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-fills', () => ({
  upsertDataSlotFill: mocks.upsertDataSlotFill,
  reconcileChatDataSlotFills: mocks.reconcileChatDataSlotFills,
}));

import { maybeRescanAfterWidening } from '@/app/api/v1/app/questionnaire-sessions/_lib/widening-rescan';

const PLAN = {
  v: 1,
  topics: [{ key: 'talent', depth: 'full', source: 'llm', rationale: 'r' }],
  excluded: [],
  checkTopicKey: null,
  confidence: 0.9,
  source: 'llm',
  respondentMessage: '',
  decidedAtTurn: 3,
  decidedAt: '2026-08-29T00:00:00.000Z',
};

function topicRow(key: string, phase: string, questionKeys: string[], dataSlotKeys: string[] = []) {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { questionKeys, dataSlotKeys },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
  };
}

function setup(
  over: {
    interviewPlan?: unknown;
    rescannedTopicKeys?: string[];
    enabled?: boolean;
    answeredIds?: string[];
  } = {}
): void {
  mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
    versionId: 'v1',
    interviewPlan: over.interviewPlan === undefined ? PLAN : over.interviewPlan,
    rescannedTopicKeys: over.rescannedTopicKeys ?? [],
    version: { config: { conditionalTopics: { enabled: over.enabled ?? true } } },
  });
  mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
    topicRow('open', 'opening', ['intro_q']),
    topicRow('talent', 'conditional', ['talent_q1', 'talent_q2']),
  ]);
  mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
    slot('intro_q'),
    slot('talent_q1'),
    slot('talent_q2'),
  ]);
  mocks.prisma.appDataSlot.findMany.mockResolvedValue([]);
  mocks.prisma.appAnswerSlot.findMany.mockResolvedValue(
    (over.answeredIds ?? []).map((questionSlotId) => ({ questionSlotId }))
  );
  mocks.prisma.appDataSlotFill.findMany.mockResolvedValue([]);
  mocks.prisma.appQuestionnaireTurn.findMany.mockResolvedValue([
    { userMessage: 'we lost two engineers last quarter', agentResponse: 'Tell me more.' },
  ]);
  mocks.prisma.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-1',
    provider: 'openai',
    model: 'gpt-test',
    fallbackProviders: [],
  });
}

function slot(key: string) {
  return {
    id: `slot-${key}`,
    key,
    prompt: `Tell me about ${key}`,
    type: 'free_text',
    typeConfig: null,
    required: false,
    weight: 1,
    guidelines: null,
  };
}

function reads(answers: Array<{ slotKey: string; confidence?: number }>): void {
  mocks.runStructuredCompletion.mockResolvedValue({
    value: {
      answers: answers.map((a) => ({
        slotKey: a.slotKey,
        value: 'they mentioned it',
        confidence: a.confidence ?? 0.9,
        provenance: 'inferred',
        rationale: 'said in the opening',
      })),
    },
    costUsd: 0.001,
    tokenUsage: { input: 10, output: 5 },
  });
}

describe('maybeRescanAfterWidening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.appQuestionnaireSession.update.mockResolvedValue({});
    mocks.upsertAnswerSlot.mockResolvedValue('answer-row');
    mocks.reconcileChatDataSlotFills.mockResolvedValue([]);
  });

  it('skips a version that never opted in, before any structure is loaded', async () => {
    setup({ enabled: false });

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({ kind: 'skipped', reason: 'conditional topics off' });
    expect(mocks.prisma.appQuestionnaireTopic.findMany).not.toHaveBeenCalled();
  });

  it('skips a session whose plan is not decided yet — nothing has widened', async () => {
    setup({ interviewPlan: null });

    expect(await maybeRescanAfterWidening('sess-1')).toEqual({
      kind: 'skipped',
      reason: 'no plan yet',
    });
  });

  it('skips without loading questions once every seated topic is in the ledger', async () => {
    setup({ rescannedTopicKeys: ['talent'] });

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({ kind: 'skipped', reason: 'nothing newly in scope' });
    // The cheap gate: on every turn after the re-read, this costs a topic query and nothing else.
    expect(mocks.prisma.appQuestionSlot.findMany).not.toHaveBeenCalled();
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('writes what the transcript already answered, capped and marked inferred', async () => {
    setup();
    reads([{ slotKey: 'talent_q1' }]);

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toMatchObject({ kind: 'rescanned', answersWritten: 1, topicKeys: ['talent'] });
    expect(mocks.upsertAnswerSlot).toHaveBeenCalledTimes(1);
    const [, questionSlotId, answer] = mocks.upsertAnswerSlot.mock.calls[0];
    expect(questionSlotId).toBe('slot-talent_q1');
    // Nobody asked this question, so it lands below the confidence floor and does not count toward
    // completion until the interviewer corroborates it.
    expect(answer).toMatchObject({ provenance: 'inferred' });
    expect(answer['confidence']).toBeCloseTo(0.45);
  });

  it('never offers a question that already has an answer', async () => {
    setup({ answeredIds: ['slot-talent_q1'] });
    reads([{ slotKey: 'talent_q2' }]);

    await maybeRescanAfterWidening('sess-1');

    const prompt = mocks.runStructuredCompletion.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('talent_q2');
    expect(prompt).not.toContain('talent_q1');
  });

  it('offers only the newly-seated topic’s questions, never the always-run ones', async () => {
    setup();
    reads([]);

    await maybeRescanAfterWidening('sess-1');

    const prompt = mocks.runStructuredCompletion.mock.calls[0][0].messages[0].content;
    // `intro_q` belongs to the opening: it was in scope from turn one and was extracted at the time.
    expect(prompt).not.toContain('intro_q');
  });

  it('banks the ledger when the read finds nothing', async () => {
    setup();
    reads([]);

    await maybeRescanAfterWidening('sess-1');

    expect(mocks.prisma.appQuestionnaireSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rescannedTopicKeys: ['talent'] } })
    );
  });

  it('does NOT bank the ledger when the call fails — the topic stays outstanding', async () => {
    setup();
    mocks.runStructuredCompletion.mockRejectedValue(new Error('provider down'));

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({ kind: 'skipped', reason: 'no usable read' });
    expect(mocks.prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });

  it('never throws, whatever the database does', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockRejectedValue(new Error('db down'));

    await expect(maybeRescanAfterWidening('sess-1')).resolves.toEqual({
      kind: 'skipped',
      reason: 'error',
    });
  });
});
