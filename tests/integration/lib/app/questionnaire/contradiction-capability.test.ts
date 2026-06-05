/**
 * Integration test for the questionnaire contradiction-detector capability (F4.3).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion` + finding normaliser, with only the provider (and the
 * DB-backed registry / binding lookups) mocked — the same seam the answer extractor
 * is tested at.
 *
 * Covers: happy path (one finding), unknown/unanswered-slot drop, symmetric dedupe,
 * empty detection, malformed-JSON repair (retry), no-silent-failure on final parse
 * failure, cost logging + isolation, provider resolution + fail-closed paths,
 * flag-vs-probe shaping, and the counts-only `redactProvenance` round-trip.
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
const { AppDetectContradictionsCapability } =
  await import('@/lib/app/questionnaire/capabilities/detect-contradictions');
const { DETECT_CONTRADICTIONS_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = DETECT_CONTRADICTIONS_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Detect Contradictions',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Detect contradictions.',
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

/** A schema-valid payload: one contradiction between two answered slots. */
const VALID_DETECTION = {
  contradictions: [
    {
      slotKeys: ['has_children', 'children_count'],
      explanation: 'Said no children but later gave a count of two.',
      severity: 'high',
      confidence: 0.9,
      suggestedProbe: 'Earlier you said no children — do you have two?',
    },
  ],
};
const VALID_JSON = JSON.stringify(VALID_DETECTION);

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    slots: [
      { key: 'has_children', prompt: 'Do you have children?', type: 'boolean' },
      { key: 'children_count', prompt: 'How many children?', type: 'numeric' },
    ],
    answers: [
      { slotKey: 'has_children', value: false, confidence: 0.9, provenance: 'direct' },
      { slotKey: 'children_count', value: 2, confidence: 0.8, provenance: 'inferred' },
    ],
    mode: 'probe',
    windowN: 0,
    sessionId: 'sess-1',
    ...overrides,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    entityContext: {
      contradictionDetectorAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppDetectContradictionsCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppDetectContradictionsCapability — dispatch', () => {
  it('returns a finding with its probe on the happy path (probe mode)', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      findings: Array<{ slotKeys: string[]; severity: string; suggestedProbe?: string }>;
      droppedCount: number;
    };
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.slotKeys).toEqual(['has_children', 'children_count']);
    expect(data.findings[0]?.severity).toBe('high');
    expect(data.findings[0]?.suggestedProbe).toContain('two');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('strips the probe under flag mode', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ mode: 'flag' }),
      baseContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { findings: Array<{ suggestedProbe?: string }> };
    expect(data.findings[0]?.suggestedProbe).toBeUndefined();
  });

  it('drops a finding that references an unknown slot, reporting the count', async () => {
    const payload = JSON.stringify({
      contradictions: [
        { slotKeys: ['has_children', 'ghost'], explanation: 'x', severity: 'low', confidence: 0.6 },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as { findings: unknown[]; droppedCount: number };
    expect(data.findings).toHaveLength(0);
    expect(data.droppedCount).toBe(1);
  });

  it('de-duplicates symmetric findings, keeping the higher-confidence one', async () => {
    const payload = JSON.stringify({
      contradictions: [
        {
          slotKeys: ['has_children', 'children_count'],
          explanation: 'low',
          severity: 'low',
          confidence: 0.5,
        },
        {
          slotKeys: ['children_count', 'has_children'],
          explanation: 'high',
          severity: 'high',
          confidence: 0.95,
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: payload }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ mode: 'flag' }),
      baseContext()
    );

    const data = result.data as {
      findings: Array<{ explanation: string }>;
      droppedCount: number;
    };
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.explanation).toBe('high');
    expect(data.droppedCount).toBe(1);
  });

  it('returns an empty findings list when the answers are consistent', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify({ contradictions: [] }) }])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect((result.data as { findings: unknown[] }).findings).toHaveLength(0);
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

  it('surfaces detection_failed (no silent fallback) when both attempts fail to parse', async () => {
    const provider = makeProvider([{ content: 'nope' }, { content: 'still nope' }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('detection_failed');
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid args (fewer than two answers) at the dispatcher boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ answers: [{ slotKey: 'has_children', value: false }] }),
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
        'detect_contradictions: logCost rejected',
        expect.objectContaining({ error: 'cost DB down' })
      )
    );
  });

  it('coerces a malformed detector binding from context to safe types', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          contradictionDetectorAgent: {
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

  it('retries on a schema-invalid (but JSON) first response', async () => {
    // Valid JSON, invalid schema (missing explanation/severity/confidence) → the
    // issue-path map runs (paths surface in the final error + logs, not the retry
    // prompt — matching F4.2), then a valid retry succeeds.
    const badSchema = JSON.stringify({ contradictions: [{ slotKeys: ['has_children'] }] });
    const provider = makeProvider([{ content: badSchema }, { content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('threads the full optional context (slot ids/sectionId/guidelines, answer turnIndex, no sessionId)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      {
        slots: [
          {
            key: 'has_children',
            prompt: 'Do you have children?',
            type: 'boolean',
            id: 'q1-id',
            sectionId: 's1',
            guidelines: 'Count step-children too',
            required: true,
          },
          { key: 'children_count', prompt: 'How many children?', type: 'numeric' },
        ],
        answers: [
          { slotKey: 'has_children', value: false, confidence: 0.9, turnIndex: 1 },
          { slotKey: 'children_count', value: 2, confidence: 0.8, turnIndex: 4 },
        ],
        mode: 'flag',
        // no sessionId → falls back to a dispatch-derived id
      },
      baseContext()
    );

    expect(result.success).toBe(true);
    expect((result.data as { findings: unknown[] }).findings).toHaveLength(1);
  });

  it('logs cost without an agentId when the context omits one', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext({ agentId: undefined }));

    const chatCall = (logCost as Mock).mock.calls.find(
      ([arg]) => arg?.metadata?.capability === SLUG
    );
    expect(chatCall, 'a CHAT cost log for this capability should have been emitted').toBeDefined();
    // Pin the positive shape (not just "defined"), then assert agentId is omitted.
    expect(chatCall?.[0]).toMatchObject({
      operation: CostOperation.CHAT,
      metadata: { capability: SLUG },
    });
    expect(chatCall?.[0]).not.toHaveProperty('agentId');
  });
});

describe('AppDetectContradictionsCapability — redactProvenance', () => {
  const capability = new AppDetectContradictionsCapability();

  it('redacts the answers and emits a PII-safe, counts-only, capped preview', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: {
        droppedCount: 1,
        findings: [
          {
            slotKeys: ['has_children', 'children_count'],
            explanation: 'Said no children but later gave a count of two.',
            severity: 'high',
            confidence: 0.9,
            suggestedProbe: 'Earlier you said no children — do you have two?',
          },
        ],
      },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs.slotCount).toBe(2);
    expect(safeArgs.answerCount).toBe(2);
    expect(safeArgs.mode).toBe('probe');
    expect(String(safeArgs.answers)).toContain('redacted');
    // The preview leaks no explanations / probes / values — counts only — and is capped.
    expect(redaction.resultPreview).not.toContain('children');
    expect(redaction.resultPreview).not.toContain('two');
    expect(redaction.resultPreview).toContain('findingCount');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
    const preview = JSON.parse(redaction.resultPreview) as {
      data: {
        findingCount: number;
        probeCount: number;
        droppedCount: number;
        severityCounts: Record<string, number>;
      };
    };
    expect(preview.data.findingCount).toBe(1);
    expect(preview.data.probeCount).toBe(1);
    expect(preview.data.droppedCount).toBe(1);
    expect(preview.data.severityCounts.high).toBe(1);
  });

  it('passes an error envelope through the preview untouched', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'detection_failed', message: 'boom' },
    });
    expect(redaction.resultPreview).toContain('detection_failed');
  });

  it('caps an over-long error preview at 200 chars with an ellipsis', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'detection_failed', message: 'x'.repeat(500) },
    });
    expect(redaction.resultPreview.length).toBe(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });

  it('omits an absent sessionId from the persisted args', () => {
    const args = {
      slots: baseArgs().slots,
      answers: baseArgs().answers,
      mode: 'flag',
      windowN: 0,
    } as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: { findings: [], droppedCount: 0 },
    });

    expect(redaction.args as Record<string, unknown>).not.toHaveProperty('sessionId');
  });
});
