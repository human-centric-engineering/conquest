/**
 * Integration test for the questionnaire answer-extractor capability (F4.2).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion` + answer-intent normaliser, with only the provider
 * (and the DB-backed registry / binding lookups) mocked. The same seam the
 * structure extractor is tested at: "unit-tested by dispatch with a mocked
 * provider; persistence is tested at the route" (and persistence doesn't exist
 * yet — F4.6).
 *
 * Covers: happy path (active + side-effect answers), value validation against the
 * slot's real type, malformed-JSON repair (retry), no-silent-failure on final
 * parse failure, cost logging, provider resolution + fail-closed paths, and the
 * `redactProvenance` round-trip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
    isLocal: false,
  })),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { AppExtractAnswerSlotsCapability } =
  await import('@/lib/app/questionnaire/capabilities/extract-answer-slots');
const { EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Extract Answer Slots',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Extract answer slots.',
      parameters: { type: 'object', properties: {} },
    },
    requiresApproval: false,
    approvalTimeoutMs: null,
    rateLimit: null,
    isIdempotent: false,
    isActive: true,
    quarantineState: 'active',
    quarantineReason: null,
    quarantineUntil: null,
  };
}

interface ChatScript {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function makeProvider(scripts: ChatScript[]) {
  let turn = 0;
  return {
    chat: vi.fn(async () => {
      const script = scripts[turn] ?? scripts[scripts.length - 1];
      turn++;
      return {
        content: script.content,
        usage: script.usage ?? { inputTokens: 100, outputTokens: 50 },
        model: 'test-model',
        finishReason: 'stop' as const,
      };
    }),
  };
}

/** A schema-valid payload: an active answer plus a side-effect on another slot. */
const VALID_EXTRACTION = {
  answers: [
    {
      slotKey: 'full_name',
      value: 'Dana Scully',
      confidence: 0.95,
      provenance: 'direct',
      rationale: 'Stated outright.',
      sourceQuote: "I'm Dana Scully",
    },
    {
      slotKey: 'city',
      value: 'Leeds',
      confidence: 0.8,
      provenance: 'inferred',
      rationale: 'Mentioned where they live.',
    },
  ],
};
const VALID_JSON = JSON.stringify(VALID_EXTRACTION);

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    userMessage: "I'm Dana Scully and I live in Leeds.",
    activeQuestionKey: 'full_name',
    candidateSlots: [
      { key: 'full_name', prompt: 'What is your name?', type: 'free_text' },
      { key: 'city', prompt: 'Where do you live?', type: 'free_text' },
    ],
    sessionId: 'sess-1',
    ...overrides,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    entityContext: { answerExtractorAgent: { provider: '', model: '', fallbackProviders: [] } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppExtractAnswerSlotsCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppExtractAnswerSlotsCapability — dispatch', () => {
  it('returns active + side-effect intents on the happy path', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      intents: Array<{ slotKey: string; isActiveQuestion: boolean; value: unknown }>;
      costUsd: number;
    };
    expect(data.intents).toHaveLength(2);
    const active = data.intents.find((i) => i.slotKey === 'full_name');
    const sideEffect = data.intents.find((i) => i.slotKey === 'city');
    expect(active?.isActiveQuestion).toBe(true);
    expect(sideEffect?.isActiveQuestion).toBe(false);
    expect(active?.value).toBe('Dana Scully');
    // F6.3: the real LLM cost is surfaced on the data (here the mocked calculateCost total),
    // so the live turn loop can sum a turn's true spend for cost-cap enforcement.
    expect(data.costUsd).toBe(0.003);
    // No retry on the happy path.
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('drops an answer whose value fails the slot type, keeping the valid one', async () => {
    // `mood` is a single_choice limited to happy/sad; the model returns an
    // off-list value, so the normaliser drops it but keeps the free_text answer.
    const payload = JSON.stringify({
      answers: [
        {
          slotKey: 'full_name',
          value: 'Dana',
          confidence: 0.9,
          provenance: 'direct',
          rationale: 'stated',
          sourceQuote: 'Dana',
        },
        {
          slotKey: 'mood',
          value: 'ecstatic',
          confidence: 0.7,
          provenance: 'inferred',
          rationale: 'x',
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({
        candidateSlots: [
          { key: 'full_name', prompt: 'Name?', type: 'free_text' },
          {
            key: 'mood',
            prompt: 'Mood?',
            type: 'single_choice',
            typeConfig: {
              choices: [
                { value: 'happy', label: 'Happy' },
                { value: 'sad', label: 'Sad' },
              ],
            },
          },
        ],
      }),
      baseContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { intents: Array<{ slotKey: string }>; droppedCount: number };
    expect(data.intents).toHaveLength(1);
    expect(data.intents[0]?.slotKey).toBe('full_name');
    // The off-list choice answer was dropped — and the count is reported, not lost.
    expect(data.droppedCount).toBe(1);
  });

  it('returns an empty intent list when the message answers nothing', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify({ answers: [] }) }])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect((result.data as { intents: unknown[] }).intents).toHaveLength(0);
  });

  it('logs LLM cost as a CHAT operation with the resolved model/provider', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: VALID_JSON, usage: { inputTokens: 321, outputTokens: 123 } }])
    );

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        operation: CostOperation.CHAT,
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 321,
        outputTokens: 123,
      })
    );
  });

  it('repairs a malformed first response via the retry path', async () => {
    const provider = makeProvider([{ content: 'not valid json' }, { content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('surfaces extraction_failed (no silent fallback) when both attempts fail to parse', async () => {
    const provider = makeProvider([{ content: 'nope' }, { content: 'still nope' }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('extraction_failed');
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid args (missing userMessage) at the dispatcher boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      { activeQuestionKey: 'full_name', candidateSlots: baseArgs().candidateSlots },
      baseContext()
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_args');
  });

  it('fails closed with no_provider_configured when no provider resolves (no LLM call)', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce(
      new Error('No active LLM provider is configured')
    );
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(getProvider).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('returns provider_unavailable when the provider cannot be built', async () => {
    (getProvider as Mock).mockRejectedValueOnce(new Error('Provider "x" is disabled'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(resolveAgentProviderAndModel).toHaveBeenCalledTimes(1);
  });

  it('resolves the chat tier and the system-default binding when context carries no agent', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({ entityContext: undefined })
    );

    expect(result.success).toBe(true);
    // Per-turn extraction resolves the `chat` tier (not `reasoning`), with an empty
    // binding → the system default.
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );
  });

  it('coerces a malformed answer-extractor binding from context to safe types', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          answerExtractorAgent: {
            provider: 123,
            model: null,
            fallbackProviders: ['keep', 7, 'also'],
          },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: ['keep', 'also'] },
      'chat'
    );
  });

  it('still succeeds when cost logging rejects (accounting failure is isolated)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));
    (logCost as Mock).mockRejectedValueOnce(new Error('cost DB down'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'extract_answer_slots: logCost rejected',
        expect.objectContaining({ error: 'cost DB down' })
      )
    );
  });

  it('surfaces a non-Error rejection as a stringified message', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce('provider exploded');

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    // errorMessage() stringifies a non-Error throw rather than dropping it.
    expect(result.error?.message).toBe('provider exploded');
  });

  it('threads the full optional context (transcript, answered, slot ids, no sessionId)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    // candidateSlots carrying id/sectionId/guidelines, recent transcript, prior
    // answers, and NO sessionId — exercises every optional branch of the
    // arg → ExtractionContext mapping and the sessionId default.
    const result = await capabilityDispatcher.dispatch(
      SLUG,
      {
        userMessage: "I'm Dana from Leeds",
        activeQuestionKey: 'full_name',
        candidateSlots: [
          {
            key: 'full_name',
            prompt: 'What is your name?',
            type: 'free_text',
            id: 'q1-id',
            sectionId: 's1',
            guidelines: 'Full legal name',
            required: true,
          },
          { key: 'city', prompt: 'Where do you live?', type: 'free_text' },
        ],
        answered: [{ slotKey: 'prior', confidence: 0.5 }],
        recentMessages: ['earlier turn'],
      },
      baseContext()
    );

    expect(result.success).toBe(true);
    expect((result.data as { intents: unknown[] }).intents).toHaveLength(2);
  });

  it('logs cost without an agentId when the context omits one', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext({ agentId: undefined }));

    // The CHAT cost log omits agentId rather than sending undefined. Assert the
    // call actually happened first — otherwise the `not.toHaveProperty` below
    // passes vacuously on `undefined` even if cost logging were skipped entirely.
    const chatCall = (logCost as Mock).mock.calls.find(
      ([arg]) => arg?.metadata?.capability === SLUG
    );
    expect(chatCall).toBeDefined();
    expect(chatCall?.[0]).not.toHaveProperty('agentId');
  });
});

describe('AppExtractAnswerSlotsCapability — redactProvenance', () => {
  const capability = new AppExtractAnswerSlotsCapability();

  it('redacts the message/transcript/answers and emits a PII-safe, capped preview', () => {
    const args = baseArgs({
      recentMessages: ['earlier private turn'],
      answered: [{ slotKey: 'prior', confidence: 0.5 }],
    }) as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: {
        droppedCount: 0,
        costUsd: 0,
        intents: [
          {
            slotKey: 'full_name',
            questionType: 'free_text',
            value: 'Dana Scully',
            confidence: 0.95,
            provenance: 'direct',
            rationale: 'r',
            isActiveQuestion: true,
            sourceQuote: 'Dana Scully',
          },
        ],
      },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs.activeQuestionKey).toBe('full_name');
    expect(safeArgs.candidateSlotCount).toBe(2);
    expect(String(safeArgs.userMessage)).toContain('redacted');
    expect(String(safeArgs.recentMessages)).toContain('redacted');
    expect(String(safeArgs.answered)).toContain('redacted');
    // The preview leaks no values / source quotes — counts only — and stays capped.
    expect(redaction.resultPreview).not.toContain('Dana Scully');
    expect(redaction.resultPreview).toContain('intentCount');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
    const preview = JSON.parse(redaction.resultPreview) as {
      data: {
        activeAnswerCount: number;
        sideEffectCount: number;
        provenanceCounts: Record<string, number>;
      };
    };
    expect(preview.data.activeAnswerCount).toBe(1);
    expect(preview.data.sideEffectCount).toBe(0);
    expect(preview.data.provenanceCounts.direct).toBe(1);
  });

  it('passes an error envelope through the preview untouched', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'extraction_failed', message: 'boom' },
    });
    expect(redaction.resultPreview).toContain('extraction_failed');
  });

  it('caps an over-long error preview at 200 chars with an ellipsis', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'extraction_failed', message: 'x'.repeat(500) },
    });
    expect(redaction.resultPreview.length).toBe(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });

  it('omits absent optional args from the persisted args', () => {
    const args = {
      userMessage: 'hi',
      activeQuestionKey: 'q1',
      candidateSlots: [{ key: 'q1', prompt: 'p', type: 'free_text' }],
    } as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0 },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs).not.toHaveProperty('recentMessages');
    expect(safeArgs).not.toHaveProperty('answered');
    expect(safeArgs).not.toHaveProperty('sessionId');
  });
});
