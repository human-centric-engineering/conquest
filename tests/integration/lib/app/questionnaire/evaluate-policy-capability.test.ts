/**
 * Integration test for the interviewer-policy evaluation capability (F18.8).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion`, with only the provider (and the DB-backed registry / binding
 * lookups) mocked — the same seam `evaluate-structure-capability.test.ts` (F5.1) is tested at,
 * which this file mirrors over the policy-evaluation vocabulary.
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
const { AppEvaluatePolicyCapability } =
  await import('@/lib/app/questionnaire/capabilities/evaluate-policy');
const { EVALUATE_POLICY_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = EVALUATE_POLICY_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Evaluate Interviewer Policy',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Evaluate an interviewer policy.',
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
      targetKey: 'house_rule:r1',
      severity: 'minor',
      proposedChange: 'Say what “appropriate” means here.',
      rationale: 'As written, no turn would behave differently.',
      sourceQuote: 'Be appropriate.',
    },
  ],
};
const VALID_JSON = JSON.stringify(VALID_VERDICT);

const STRUCTURE = {
  meta: {
    title: 'T',
    goal: 'Understand growth',
    audienceSummary: null,
    sectionCount: 1,
    questionCount: 1,
  },
  context: {
    presentationMode: 'both',
    anonymousMode: false,
    sensitivityAwareness: false,
    hasSupportMessage: false,
    answerConfidenceFloor: 0.5,
  },
  tone: { personaSelectionEnabled: false, personaText: null, dials: [] },
  houseRules: {
    enabled: true,
    rules: [{ id: 'r1', kind: 'never', enabled: true, text: 'Be appropriate.', trigger: null }],
  },
  strategy: {
    enabled: true,
    approach: 'funnel',
    pace: 'balanced',
    openingMode: 'auto',
    openingExamples: [],
    probeDepth: true,
    reflect: false,
    batchRelated: true,
    paceProfile: {
      openingWindow: 2,
      openBelow: 0.4,
      targetedAbove: 0.75,
      openRounds: 3,
      targetedRounds: 8,
    },
    guidedOpeningActive: false,
  },
  fidelity: {
    enabled: true,
    defaultFidelity: 0.5,
    defaultLevel: 'balanced',
    distribution: { free: 0, loose: 0, balanced: 1, close: 0, must_ask: 0 },
    satisfactionFloors: { free: 0.5, loose: 0.5, balanced: 0.5, close: 0.65, must_ask: 0.85 },
    questions: [
      {
        key: 'q1',
        prompt: 'How is retention?',
        type: 'free_text',
        required: true,
        weight: 1,
        sectionTitle: 'S',
        level: 'balanced',
        storedLevel: 'balanced',
        topicKeys: [],
      },
    ],
    questionsShown: 1,
    questionsTotal: 1,
    truncated: false,
  },
  routing: {
    adaptiveScopeEnabled: false,
    maxConditionalTopics: 3,
    limitOpeningProbes: false,
    maxOpeningProbes: 1,
    mustAskByTopic: [],
  },
  knownIssues: [],
};

function baseArgs(overrides: Record<string, unknown> = {}) {
  return { dimension: 'rule_coherence', structure: STRUCTURE, versionId: 'v1', ...overrides };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'judge-rule-coherence-1',
    entityContext: {
      judgeAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppEvaluatePolicyCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppEvaluatePolicyCapability — dispatch', () => {
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
      baseArgs({ dimension: 'arc_fit' }),
      baseContext()
    );

    const data = result.data as { verdict: { dimension: string } };
    expect(data.verdict.dimension).toBe('arc_fit');
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
      baseArgs({ dimension: 'cross_layer_conflict' }),
      baseContext()
    );

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'judge-rule-coherence-1',
        operation: CostOperation.CHAT,
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 321,
        outputTokens: 123,
        metadata: expect.objectContaining({
          capability: SLUG,
          dimension: 'cross_layer_conflict',
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
    expect(call.metadata.dimension).toBe('rule_coherence');
  });
});
