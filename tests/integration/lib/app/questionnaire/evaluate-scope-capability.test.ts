/**
 * Integration test for the Adaptive Scope evaluation capability (F17.21).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion`, with only the provider (and the DB-backed registry / binding
 * lookups) mocked — the same seam `evaluate-structure-capability.test.ts` (F5.1) is tested at,
 * which this file mirrors line for line over the scope-evaluation vocabulary.
 *
 * Covers: happy path (score + findings), a clean pass (empty findings), the dimension stamp,
 * malformed-JSON repair (retry), no-silent-failure on final parse failure, cost logging with the
 * dimension in metadata, the `reasoning` tier + system-default binding, and the
 * provider-resolution fail-closed path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
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
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { AppEvaluateScopeCapability } =
  await import('@/lib/app/questionnaire/capabilities/evaluate-scope');
const { EVALUATE_SCOPE_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = EVALUATE_SCOPE_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Evaluate Adaptive Scope',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Evaluate an Adaptive Scope configuration.',
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
    chat: vi.fn(async (_messages: unknown, _options: unknown) => {
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

const VALID_VERDICT = {
  score: 0.7,
  findings: [
    {
      targetKey: 'topic:talent',
      severity: 'minor',
      proposedChange: 'Make the criteria more specific.',
      rationale: 'Currently too broad.',
      sourceQuote: 'when relevant',
    },
  ],
};
const VALID_JSON = JSON.stringify(VALID_VERDICT);

const STRUCTURE = {
  topics: [
    {
      key: 'talent',
      label: 'Talent & culture',
      phase: 'conditional',
      criteria: 'when relevant',
      depth: 'full',
      members: [{ key: 'q1', label: 'How is retention?' }],
    },
  ],
  rules: [],
  settings: {
    maxConditionalTopics: 3,
    includeCheckTopic: true,
    fallbackTopicKeys: [],
    minConfidence: 0.6,
    plannerInstructions: '',
    sessionBudgetSeconds: 600,
    limitOpeningProbes: false,
    maxOpeningProbes: 1,
  },
  costs: { budgetSeconds: 600, alwaysSeconds: 60, routedAllowanceSeconds: 540, perTopic: [] },
  knownIssues: [],
};

function baseArgs(overrides: Record<string, unknown> = {}) {
  return { dimension: 'criteria_quality', structure: STRUCTURE, versionId: 'v1', ...overrides };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'judge-criteria-quality-1',
    entityContext: {
      judgeAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppEvaluateScopeCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppEvaluateScopeCapability — dispatch', () => {
  it('returns a verdict with score + findings on the happy path', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      verdict: { dimension: string; score: number; findings: unknown[] };
    };
    expect(data.verdict.score).toBe(0.7);
    expect(data.verdict.findings).toHaveLength(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('stamps the dispatched dimension onto the verdict (LLM never labels its own)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ dimension: 'budget_realism' }),
      baseContext()
    );

    const data = result.data as { verdict: { dimension: string } };
    expect(data.verdict.dimension).toBe('budget_realism');
  });

  it('accepts a clean pass — empty findings array', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify({ score: 1, findings: [] }) }])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as { verdict: { findings: unknown[] } };
    expect(data.verdict.findings).toEqual([]);
  });

  it('resolves the reasoning tier and the system-default binding when context carries no agent', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({ entityContext: undefined })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('logs LLM cost as a CHAT operation with the dimension in metadata', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: VALID_JSON, usage: { inputTokens: 321, outputTokens: 123 } }])
    );

    await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ dimension: 'coverage_and_burden' }),
      baseContext()
    );

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'judge-criteria-quality-1',
        operation: CostOperation.CHAT,
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 321,
        outputTokens: 123,
        metadata: expect.objectContaining({
          capability: SLUG,
          dimension: 'coverage_and_burden',
          versionId: 'v1',
        }),
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

  it('surfaces evaluation_failed (no silent fallback) when both attempts fail to parse', async () => {
    const provider = makeProvider([{ content: 'nope' }, { content: 'still nope' }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('evaluation_failed');
  });

  it('fails closed with no_provider_configured when no provider resolves', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });

  it('rejects an unknown dimension at the schema boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ dimension: 'vibes' }),
      baseContext()
    );

    expect(result.success).toBe(false);
  });

  it('rejects a structure that fails the scope-structure schema', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ structure: { ...STRUCTURE, topics: 'not-an-array' } }),
      baseContext()
    );

    expect(result.success).toBe(false);
  });

  it('fails closed with provider_unavailable when the provider cannot be loaded', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('provider down'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('coerces a malformed judgeAgent binding to the empty (system-default) binding', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: { judgeAgent: { provider: 123, model: null, fallbackProviders: 'nope' } },
      })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('drops non-string entries from a judgeAgent fallbackProviders array', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          judgeAgent: { provider: 'p', model: 'm', fallbackProviders: ['ok', 7, null, 'two'] },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'p', model: 'm', fallbackProviders: ['ok', 'two'] },
      'reasoning'
    );
  });

  it('names the invalid field paths when the response is valid JSON but fails the schema', async () => {
    const bad = JSON.stringify({ score: 5, findings: [] });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: bad }, { content: bad }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('evaluation_failed');
    expect(result.error?.message).toContain('score');
  });

  it('blames truncation, not the schema, when no attempt parsed as JSON', async () => {
    const truncated =
      '{"score":0.6,"findings":[{"targetKey":"topic:talent","severity":"minor","proposedChange":"Make the';
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: truncated }, { content: truncated }])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('evaluation_failed');
    expect(result.error?.message).toContain('truncated');
    expect(result.error?.message).toContain('8192');
    expect(result.error?.message).not.toContain('not valid against the schema');
  });

  it('asks the provider for a budget that survives a reasoning model on a long config', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const options = provider.chat.mock.calls[0][1] as { maxTokens: number; timeoutMs: number };
    expect(options.maxTokens).toBe(8_192);
    expect(options.timeoutMs).toBe(90_000);
  });

  it('omits versionId from cost metadata when absent', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ versionId: undefined }),
      baseContext()
    );

    expect(result.success).toBe(true);
    const call = (logCost as Mock).mock.calls[0][0];
    expect(call.metadata.versionId).toBeUndefined();
    expect(call.metadata.dimension).toBe('criteria_quality');
  });
});
