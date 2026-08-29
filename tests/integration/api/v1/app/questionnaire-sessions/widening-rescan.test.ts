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
    appQuestionnaireSession: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
  upsertDataSlotFill: vi.fn(
    async (_sessionId: string, _dataSlotId: string, _fill: Record<string, unknown>) => ({
      id: 'fill-row',
      changed: true,
    })
  ),
  // Returns the AppDataSlotFill row IDS it wrote (`Promise<string[]>`), not row objects — see
  // data-slot-fills.ts. The runner only reads `.length`, so a wrong shape here would still pass.
  reconcileChatDataSlotFills: vi.fn(
    async (_args: { sessionId: string; answeredQuestionSlotIds: string[] }): Promise<string[]> => []
  ),
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

import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
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
    rescannedTopicKeys?: unknown;
    enabled?: boolean;
    answeredIds?: string[];
    filledIds?: string[];
    dataSlotKeys?: string[];
    turns?: Array<{ userMessage: string; agentResponse: string }>;
  } = {}
): void {
  const dataSlotKeys = over.dataSlotKeys ?? [];
  mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
    versionId: 'v1',
    interviewPlan: over.interviewPlan === undefined ? PLAN : over.interviewPlan,
    rescannedTopicKeys: over.rescannedTopicKeys ?? [],
    version: { config: { conditionalTopics: { enabled: over.enabled ?? true } } },
  });
  mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([
    topicRow('open', 'opening', ['intro_q']),
    topicRow('talent', 'conditional', ['talent_q1', 'talent_q2'], dataSlotKeys),
  ]);
  mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
    slot('intro_q'),
    slot('talent_q1'),
    slot('talent_q2'),
  ]);
  mocks.prisma.appDataSlot.findMany.mockResolvedValue(dataSlotKeys.map(dataSlot));
  mocks.prisma.appAnswerSlot.findMany.mockResolvedValue(
    (over.answeredIds ?? []).map((questionSlotId) => ({ questionSlotId }))
  );
  mocks.prisma.appDataSlotFill.findMany.mockResolvedValue(
    (over.filledIds ?? []).map((dataSlotId) => ({ dataSlotId }))
  );
  mocks.prisma.appQuestionnaireTurn.findMany.mockResolvedValue(
    over.turns ?? [
      { userMessage: 'we lost two engineers last quarter', agentResponse: 'Tell me more.' },
    ]
  );
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

function dataSlot(key: string) {
  return {
    id: `ds-${key}`,
    key,
    name: key,
    description: `what ${key} covers`,
    theme: 'Talent',
    weight: 1,
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
    // The ledger claim: by default this pass wins the lease. Tests that exercise an overlapping
    // turn override it with `{ count: 0 }`.
    mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 1 });
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

  it('carries a paraphrase through to the answer row when the read produced one', async () => {
    // Free-text answers are shown in the panel as their paraphrase, not their raw value — a
    // re-read answer with the field dropped would appear in the panel as a blank capture.
    setup();
    mocks.runStructuredCompletion.mockResolvedValue({
      value: {
        answers: [
          {
            slotKey: 'talent_q1',
            value: 'we lost two engineers last quarter',
            confidence: 0.9,
            provenance: 'inferred',
            rationale: 'said in the opening',
            paraphrase: 'They lost two engineers last quarter.',
          },
        ],
      },
      costUsd: 0.001,
      tokenUsage: { input: 10, output: 5 },
    });

    await maybeRescanAfterWidening('sess-1');

    const [, , answer] = mocks.upsertAnswerSlot.mock.calls[0];
    expect(answer['paraphrase']).toBe('They lost two engineers last quarter.');
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

    // Banked by the CLAIM, taken before the paid call, and never released because the call
    // succeeded — a read that found nothing is still a read, and re-paying for it every turn is
    // what the ledger exists to stop.
    expect(mocks.prisma.appQuestionnaireSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', rescannedTopicKeys: { equals: [] } },
      data: { rescannedTopicKeys: ['talent'] },
    });
  });

  it('claims the ledger BEFORE paying for the read, not after', async () => {
    setup();
    reads([]);

    await maybeRescanAfterWidening('sess-1');

    // Order is the whole fix: two overlapping turns both pass the check at the top, so the lease
    // has to be taken before the spend or both of them spend.
    const claimedAt = mocks.prisma.appQuestionnaireSession.updateMany.mock.invocationCallOrder[0];
    const calledAt = mocks.runStructuredCompletion.mock.invocationCallOrder[0];
    expect(claimedAt).toBeLessThan(calledAt);
  });

  it('skips without paying when an overlapping turn already holds the claim', async () => {
    setup();
    reads([]);
    // The compare-and-set matched no rows: another turn moved the ledger off the value we read.
    mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'another turn is already re-reading these topics',
    });
    // The point of the whole exercise: the loser spends nothing.
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('compares against the RAW ledger value, not the cleaned copy', async () => {
    // A row holding a non-string would otherwise never match its own claim, and the pass would skip
    // for ever rather than run twice — the silent failure mode of getting this wrong.
    setup({ rescannedTopicKeys: [42, 'done'] });
    reads([]);

    await maybeRescanAfterWidening('sess-1');

    expect(mocks.prisma.appQuestionnaireSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-1', rescannedTopicKeys: { equals: [42, 'done'] } },
      })
    );
  });

  it('does NOT bank the ledger when the call fails — the topic stays outstanding', async () => {
    setup();
    mocks.runStructuredCompletion.mockRejectedValueOnce(new Error('provider down'));

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({ kind: 'skipped', reason: 'no usable read' });
    // The claim is taken before the call and RELEASED when it fails, so the end state is what the
    // rule has always promised: the topic is still outstanding and the next widening may retry it.
    // Asserting "no write happened" would now be asserting the lease does not exist.
    expect(mocks.prisma.appQuestionnaireSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { rescannedTopicKeys: [] },
    });
  });

  it('never throws, whatever the database does', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockRejectedValueOnce(new Error('db down'));

    await expect(maybeRescanAfterWidening('sess-1')).resolves.toEqual({
      kind: 'skipped',
      reason: 'error',
    });
  });

  it('skips a session that no longer exists', async () => {
    // The pass is started before the `done` frame and awaited after it; a session deleted in
    // between must read as nothing to do, not as an error on the turn.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(null);

    expect(await maybeRescanAfterWidening('sess-1')).toEqual({
      kind: 'skipped',
      reason: 'session not found',
    });
  });

  it('tolerates a ledger column holding something that is not a list of keys', async () => {
    // Json column: a hand-edited or half-migrated row must not take down a turn.
    setup({ rescannedTopicKeys: { talent: true } });
    reads([]);

    expect(await maybeRescanAfterWidening('sess-1')).toMatchObject({ kind: 'rescanned' });
  });

  it('banks the ledger and stops when every question in the new topic is already answered', async () => {
    setup({ answeredIds: ['slot-talent_q1', 'slot-talent_q2'] });

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({ kind: 'skipped', reason: 'nothing unanswered in the new topics' });
    // Banked anyway: there is nothing here to find, and rediscovering that every turn is the cost
    // this ledger exists to avoid.
    expect(mocks.prisma.appQuestionnaireSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rescannedTopicKeys: ['talent'] } })
    );
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('banks the ledger and stops when there is no transcript to re-read', async () => {
    setup({ turns: [] });

    const result = await maybeRescanAfterWidening('sess-1');

    expect(result).toEqual({ kind: 'skipped', reason: 'no transcript to re-read' });
    expect(mocks.prisma.appQuestionnaireSession.update).toHaveBeenCalledTimes(1);
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('reads a turn respondent-first, and drops a blank half rather than a blank line', async () => {
    // Both columns are NOT NULL, so a missing half is the empty string. Order matters more than it
    // looks: a turn is "what they said" then "what we replied", and emitting the reply first would
    // pair every answer with the question that came AFTER it — exactly the mis-attribution the
    // prompt's first rule asks the model to avoid.
    setup({
      turns: [
        { userMessage: 'we lost two engineers', agentResponse: 'That sounds hard.' },
        { userMessage: '   ', agentResponse: 'Tell me more about hiring.' },
      ],
    });
    reads([]);

    await maybeRescanAfterWidening('sess-1');

    const prompt = mocks.runStructuredCompletion.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain(
      'Respondent: we lost two engineers\nInterviewer: That sounds hard.\nInterviewer: Tell me more about hiring.'
    );
    expect(prompt).not.toContain('Respondent:    ');
  });

  describe('data slots', () => {
    it('offers unfilled data slots and writes what the transcript already covered', async () => {
      setup({ dataSlotKeys: ['talent_ds'] });
      mocks.runStructuredCompletion.mockResolvedValue({
        value: {
          answers: [],
          dataSlotFills: [
            {
              dataSlotKey: 'talent_ds',
              value: 'attrition is the pressure point',
              paraphrase: 'They see attrition as the pressure point.',
              confidence: 0.95,
              provenance: 'inferred',
              rationale: 'said unprompted in the opening',
            },
          ],
        },
        costUsd: 0.001,
        tokenUsage: { input: 10, output: 5 },
      });

      const result = await maybeRescanAfterWidening('sess-1');

      expect(result).toMatchObject({ kind: 'rescanned', dataSlotsWritten: 1 });
      const [, dataSlotId, fill] = mocks.upsertDataSlotFill.mock.calls[0];
      expect(dataSlotId).toBe('ds-talent_ds');
      // Nobody asked them to state this position, so it gets the free-text opportunistic ceiling.
      expect(fill).toMatchObject({ provenance: 'inferred', rationale: expect.any(String) });
      expect(fill['confidence']).toBeCloseTo(0.45);
    });

    it('omits rationale entirely when the read gave none, rather than writing an empty one', async () => {
      setup({ dataSlotKeys: ['talent_ds'] });
      mocks.runStructuredCompletion.mockResolvedValue({
        value: {
          answers: [],
          dataSlotFills: [
            {
              dataSlotKey: 'talent_ds',
              value: 'attrition is the pressure point',
              paraphrase: 'They see attrition as the pressure point.',
              confidence: 0.95,
              provenance: 'inferred',
            },
          ],
        },
        costUsd: 0.001,
        tokenUsage: { input: 10, output: 5 },
      });

      await maybeRescanAfterWidening('sess-1');

      const [, , fill] = mocks.upsertDataSlotFill.mock.calls[0];
      expect(fill).not.toHaveProperty('rationale');
    });

    it('never re-derives a data slot the conversation already filled', async () => {
      setup({ dataSlotKeys: ['talent_ds'], filledIds: ['ds-talent_ds'] });
      reads([{ slotKey: 'talent_q1' }]);

      await maybeRescanAfterWidening('sess-1');

      const prompt = mocks.runStructuredCompletion.mock.calls[0][0].messages[0].content;
      expect(prompt).not.toContain('topics_to_check');
      expect(mocks.upsertDataSlotFill).not.toHaveBeenCalled();
    });

    it('drops a fill naming a data slot that was never a candidate', async () => {
      setup({ dataSlotKeys: ['talent_ds'] });
      mocks.runStructuredCompletion.mockResolvedValue({
        value: {
          answers: [],
          dataSlotFills: [
            {
              dataSlotKey: 'invented_ds',
              value: 'x',
              paraphrase: 'x',
              confidence: 0.9,
              provenance: 'inferred',
            },
          ],
        },
        costUsd: 0.001,
        tokenUsage: { input: 10, output: 5 },
      });

      expect(await maybeRescanAfterWidening('sess-1')).toMatchObject({ dataSlotsWritten: 0 });
      expect(mocks.upsertDataSlotFill).not.toHaveBeenCalled();
    });

    it('counts the parent slots the deterministic gap-filler adds for a written answer', async () => {
      setup();
      reads([{ slotKey: 'talent_q1' }]);
      mocks.reconcileChatDataSlotFills.mockResolvedValue(['ds-1', 'ds-2']);

      const result = await maybeRescanAfterWidening('sess-1');

      expect(mocks.reconcileChatDataSlotFills).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        answeredQuestionSlotIds: ['slot-talent_q1'],
      });
      expect(result).toMatchObject({ dataSlotsWritten: 2 });
    });
  });

  describe('the model call degrades to doing nothing', () => {
    it('gives up when the extractor agent is not configured', async () => {
      setup();
      mocks.prisma.aiAgent.findUnique.mockResolvedValue(null);

      expect(await maybeRescanAfterWidening('sess-1')).toEqual({
        kind: 'skipped',
        reason: 'no usable read',
      });
      // Released, so the topic is left outstanding exactly as before the lease existed.
      expect(mocks.prisma.appQuestionnaireSession.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { rescannedTopicKeys: [] },
      });
    });

    it('gives up when the agent lookup itself fails', async () => {
      setup();
      mocks.prisma.aiAgent.findUnique.mockRejectedValueOnce(new Error('agent table gone'));

      expect(await maybeRescanAfterWidening('sess-1')).toEqual({
        kind: 'skipped',
        reason: 'no usable read',
      });
    });

    it('gives up when no provider can be resolved', async () => {
      setup();
      vi.mocked(resolveAgentProviderAndModel).mockRejectedValueOnce(new Error('no provider'));

      expect(await maybeRescanAfterWidening('sess-1')).toEqual({
        kind: 'skipped',
        reason: 'no usable read',
      });
    });

    it('treats a zero-cost completion as zero rather than undefined', async () => {
      setup();
      mocks.runStructuredCompletion.mockResolvedValue({
        value: { answers: [] },
        tokenUsage: { input: 10, output: 5 },
      });

      expect(await maybeRescanAfterWidening('sess-1')).toMatchObject({ costUsd: 0 });
    });

    it('survives a cost-log rejection — the answers are already written', async () => {
      setup();
      reads([{ slotKey: 'talent_q1' }]);
      mocks.logCost.mockRejectedValueOnce(new Error('cost table down'));

      expect(await maybeRescanAfterWidening('sess-1')).toMatchObject({
        kind: 'rescanned',
        answersWritten: 1,
      });
    });
  });

  describe('the response parser', () => {
    /** The `parse` callback the runner hands `runStructuredCompletion`, captured from the call. */
    async function capturedParse(): Promise<(raw: string) => unknown> {
      setup();
      reads([]);
      await maybeRescanAfterWidening('sess-1');
      return mocks.runStructuredCompletion.mock.calls[0][0].parse;
    }

    it('accepts a valid extraction envelope', async () => {
      const parse = await capturedParse();
      expect(
        parse(
          '{"answers":[{"slotKey":"talent_q1","value":"yes","confidence":0.8,' +
            '"provenance":"inferred","rationale":"said in the opening"}]}'
        )
      ).toMatchObject({ answers: [{ slotKey: 'talent_q1' }] });
    });

    it('rejects a reply that is not the extraction shape', async () => {
      const parse = await capturedParse();
      // Returning null is what drives the one retry; anything looser would let a malformed reply
      // through to `normalizeAnswerIntents`.
      expect(parse('{"answers":"all of them"}')).toBeNull();
      // A structurally-valid answer missing `provenance` is rejected too — the ceilings and the
      // panel's "inferred" dot both key off it.
      expect(
        parse('{"answers":[{"slotKey":"talent_q1","value":"yes","confidence":0.8}]}')
      ).toBeNull();
      expect(parse('not json at all')).toBeNull();
    });

    it('fails the call rather than inventing an empty read after the retry', async () => {
      setup();
      reads([]);
      await maybeRescanAfterWidening('sess-1');
      const opts = mocks.runStructuredCompletion.mock.calls[0][0];
      expect(opts.onFinalFailure()).toBeInstanceOf(Error);
      expect(opts.retryUserMessage).toContain('answers');
    });
  });
});
