/**
 * Integration test for the questionnaire answer-refiner capability (F4.4).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion` + decision normaliser, with only the provider (and the
 * DB-backed registry / binding lookups) mocked — the same seam the extractor and
 * detector are tested at.
 *
 * Covers: happy refine + overwrite, leave filtered, unknown/unanswered-slot drop,
 * value-fails-type drop, no-op drop, per-slot dedupe, empty pass, malformed-JSON
 * repair (retry), no-silent-failure on final parse failure, invalid-args boundary,
 * cost logging + isolation, provider resolution + fail-closed paths, default binding,
 * malformed-binding coercion, and the counts-only `redactProvenance` round-trip.
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
const { AppRefineAnswerCapability } =
  await import('@/lib/app/questionnaire/capabilities/refine-answer');
const { REFINE_ANSWER_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = REFINE_ANSWER_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Refine Answer',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Refine answers.',
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

/** A choice typeConfig over the given option values. */
function choices(...values: string[]) {
  return { choices: values.map((v) => ({ value: v, label: v.toUpperCase() })) };
}

/** A schema-valid payload: refine the color answer from red → green. */
const VALID_REFINEMENT = {
  refinements: [
    {
      slotKey: 'color',
      action: 'refine',
      newValue: 'green',
      rationale: 'they reconsidered and now prefer green',
      source: 'clarification',
      confidence: 0.9,
    },
  ],
};
const VALID_JSON = JSON.stringify(VALID_REFINEMENT);

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    slots: [
      {
        key: 'color',
        prompt: 'Favourite colour?',
        type: 'single_choice',
        typeConfig: choices('red', 'green', 'blue'),
      },
      { key: 'mood', prompt: 'How do you feel?', type: 'free_text' },
    ],
    existingAnswers: [
      { slotKey: 'color', value: 'red', provenance: 'direct' },
      { slotKey: 'mood', value: 'happy', provenance: 'direct' },
    ],
    userMessage: 'actually I prefer green now',
    sessionId: 'sess-1',
    ...overrides,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    entityContext: {
      answerRefinerAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppRefineAnswerCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppRefineAnswerCapability — dispatch', () => {
  it('returns a refine decision on the happy path', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      decisions: Array<{
        slotKey: string;
        action: string;
        newValue: unknown;
        questionType: string;
      }>;
      droppedCount: number;
      costUsd: number;
    };
    expect(data.decisions).toHaveLength(1);
    expect(data.decisions[0]).toMatchObject({
      slotKey: 'color',
      action: 'refine',
      newValue: 'green',
    });
    // questionType is resolved from the slot, not the LLM.
    expect(data.decisions[0]?.questionType).toBe('single_choice');
    // F6.3: the real LLM cost is surfaced on the data so the live turn loop can sum turn spend.
    expect(data.costUsd).toBe(0.003);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('returns an overwrite decision (provenance handling is applyRefinement’s job)', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'mood',
          action: 'overwrite',
          newValue: 'content',
          rationale: 'typo fix',
          source: 'correction',
          confidence: 0.85,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const data = result.data as { decisions: Array<{ action: string; source: string }> };
    expect(data.decisions[0]?.action).toBe('overwrite');
    expect(data.decisions[0]?.source).toBe('correction');
  });

  it('filters out a leave decision (not a drop)', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'color',
          action: 'leave',
          rationale: 'unchanged',
          source: 'clarification',
          confidence: 0.5,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const data = result.data as { decisions: unknown[]; droppedCount: number };
    expect(data.decisions).toHaveLength(0);
    expect(data.droppedCount).toBe(0);
  });

  it('drops a decision for an unknown slot, reporting the count', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'ghost',
          action: 'refine',
          newValue: 'x',
          rationale: 'x',
          source: 'clarification',
          confidence: 0.6,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const data = result.data as { decisions: unknown[]; droppedCount: number };
    expect(data.decisions).toHaveLength(0);
    expect(data.droppedCount).toBe(1);
  });

  it('drops a decision for a known but not-yet-answered slot', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'extra',
          action: 'refine',
          newValue: 'v',
          rationale: 'x',
          source: 'clarification',
          confidence: 0.7,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({
        slots: [
          ...baseArgs().slots,
          { key: 'extra', prompt: 'Extra?', type: 'free_text' }, // defined but unanswered
        ],
      }),
      baseContext()
    );

    const data = result.data as { decisions: unknown[]; droppedCount: number };
    expect(data.decisions).toHaveLength(0);
    expect(data.droppedCount).toBe(1);
  });

  it('drops a refine whose new value fails the slot type (choice membership)', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'color',
          action: 'refine',
          newValue: 'purple',
          rationale: 'x',
          source: 'clarification',
          confidence: 0.8,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const data = result.data as { decisions: unknown[]; droppedCount: number };
    expect(data.decisions).toHaveLength(0);
    expect(data.droppedCount).toBe(1);
  });

  it('drops a no-op refine (new value equals the existing one)', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'color',
          action: 'refine',
          newValue: 'red',
          rationale: 'x',
          source: 'clarification',
          confidence: 0.8,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const data = result.data as { decisions: unknown[]; droppedCount: number };
    expect(data.decisions).toHaveLength(0);
    expect(data.droppedCount).toBe(1);
  });

  it('de-duplicates per slot, keeping the higher-confidence decision', async () => {
    const payload = JSON.stringify({
      refinements: [
        {
          slotKey: 'color',
          action: 'refine',
          newValue: 'green',
          rationale: 'low',
          source: 'clarification',
          confidence: 0.5,
        },
        {
          slotKey: 'color',
          action: 'refine',
          newValue: 'blue',
          rationale: 'high',
          source: 'clarification',
          confidence: 0.95,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const data = result.data as {
      decisions: Array<{ newValue: unknown; rationale: string }>;
      droppedCount: number;
    };
    expect(data.decisions).toHaveLength(1);
    expect(data.decisions[0]?.newValue).toBe('blue');
    expect(data.decisions[0]?.rationale).toBe('high');
    expect(data.droppedCount).toBe(1);
  });

  it('returns an empty decision list when nothing should change', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify({ refinements: [] }) }])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect((result.data as { decisions: unknown[] }).decisions).toHaveLength(0);
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

  it('repairs a schema-invalid (but JSON) first response via the retry path', async () => {
    // Valid JSON, invalid schema (missing rationale/source/confidence) → the issue-path
    // map runs (paths surface in the final error + logs, not the retry prompt — matching
    // F4.2/F4.3), then a valid retry succeeds.
    const badSchema = JSON.stringify({ refinements: [{ slotKey: 'color', action: 'refine' }] });
    const provider = makeProvider([{ content: badSchema }, { content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('surfaces refinement_failed (no silent fallback) when both attempts fail to parse', async () => {
    const provider = makeProvider([{ content: 'nope' }, { content: 'still nope' }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('refinement_failed');
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid args (no existing answers) at the dispatcher boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ existingAnswers: [] }),
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
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
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
        'refine_answer: logCost rejected',
        expect.objectContaining({ error: 'cost DB down' })
      )
    );
  });

  it('threads the full optional context (slot ids/sectionId/guidelines, answer rationale/confidence/turnIndex, contradiction, recentMessages) — and omits sessionId', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      {
        slots: [
          {
            key: 'color',
            prompt: 'Favourite colour?',
            type: 'single_choice',
            typeConfig: choices('red', 'green', 'blue'),
            id: 'q-color',
            sectionId: 's1',
            guidelines: 'Pick the one you wear most',
            required: true,
          },
        ],
        existingAnswers: [
          {
            slotKey: 'color',
            value: 'red',
            provenance: 'direct',
            rationale: 'they said red',
            confidence: 0.7,
            turnIndex: 2,
          },
        ],
        userMessage: 'actually green',
        triggeringContradiction: {
          slotKeys: ['color'],
          explanation: 'said red then green',
          suggestedProbe: 'red or green?',
        },
        recentMessages: ['agent: which colour?', 'user: red', 'user: actually green'],
        // no sessionId → falls back to a dispatch-derived id
      },
      baseContext()
    );

    expect(result.success).toBe(true);
    expect((result.data as { decisions: unknown[] }).decisions).toHaveLength(1);
    // The cost log uses the dispatch-derived sessionId fallback (no sessionId supplied).
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { capability: SLUG, appQuestionnaireSessionId: 'dispatch-refine' },
      })
    );
  });

  it('logs cost without an agentId when the context omits one', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext({ agentId: undefined }));

    const chatCall = (logCost as Mock).mock.calls.find(
      ([arg]) => arg?.metadata?.capability === SLUG
    );
    expect(chatCall, 'a CHAT cost log for this capability should have been emitted').toBeDefined();
    expect(chatCall?.[0]).toMatchObject({
      operation: CostOperation.CHAT,
      metadata: { capability: SLUG },
    });
    expect(chatCall?.[0]).not.toHaveProperty('agentId');
  });

  it('coerces a malformed refiner binding from context to safe types', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          answerRefinerAgent: {
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
});

describe('AppRefineAnswerCapability — redactProvenance', () => {
  const capability = new AppRefineAnswerCapability();

  it('redacts the answers and emits a PII-safe, counts-only, capped preview', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: {
        droppedCount: 1,
        costUsd: 0,
        decisions: [
          {
            slotKey: 'color',
            action: 'refine',
            questionType: 'single_choice',
            newValue: 'green',
            rationale: 'they reconsidered and now prefer green',
            source: 'clarification',
            confidence: 0.9,
          },
        ],
      },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs.slotCount).toBe(2);
    expect(safeArgs.answerCount).toBe(2);
    expect(safeArgs.hasUserMessage).toBe(true);
    expect(String(safeArgs.existingAnswers)).toContain('redacted');
    // The preview leaks no values / rationales — counts only — and is capped.
    expect(redaction.resultPreview).not.toContain('green');
    expect(redaction.resultPreview).not.toContain('reconsidered');
    expect(redaction.resultPreview).toContain('refineCount');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
    const preview = JSON.parse(redaction.resultPreview) as {
      data: { refineCount: number; overwriteCount: number; droppedCount: number };
    };
    expect(preview.data.refineCount).toBe(1);
    expect(preview.data.overwriteCount).toBe(0);
    expect(preview.data.droppedCount).toBe(1);
  });

  it('passes an error envelope through the preview untouched', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'refinement_failed', message: 'boom' },
    });
    expect(redaction.resultPreview).toContain('refinement_failed');
  });

  it('caps an over-long error preview at 200 chars with an ellipsis', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'refinement_failed', message: 'x'.repeat(500) },
    });
    expect(redaction.resultPreview.length).toBe(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });
});
