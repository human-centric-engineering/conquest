/**
 * Integration test for the design-time structure-evaluation capability (F5.1).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion`, with only the provider (and the DB-backed registry /
 * binding lookups) mocked — the same seam the F4 questionnaire capabilities are tested
 * at.
 *
 * Covers: happy path (score + findings), a clean pass (empty findings), the dimension
 * stamp, malformed-JSON repair (retry), no-silent-failure on final parse failure, cost
 * logging with the dimension in metadata, the `reasoning` tier + system-default binding,
 * and the provider-resolution fail-closed path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    // The dispatcher resolves the capability + its binding from these two tables;
    // it never calls aiAgent here (the route loads judge agents, not the capability).
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
const { AppEvaluateStructureCapability } =
  await import('@/lib/app/questionnaire/capabilities/evaluate-structure');
const { EVALUATE_STRUCTURE_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = EVALUATE_STRUCTURE_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Evaluate Questionnaire Structure',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Evaluate a questionnaire structure.',
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

const VALID_VERDICT = {
  score: 0.7,
  findings: [
    {
      targetKey: 'q_role',
      severity: 'minor',
      proposedChange: 'Split into role and tenure.',
      rationale: 'It asks two things at once.',
      sourceQuote: 'What is your role and how long?',
    },
  ],
};
const VALID_JSON = JSON.stringify(VALID_VERDICT);

const STRUCTURE = {
  goal: 'Understand onboarding friction.',
  audience: { role: 'Engineer', expertiseLevel: 'intermediate' as const },
  sections: [
    {
      title: 'Background',
      questions: [
        {
          key: 'q_role',
          prompt: 'What is your role and how long?',
          type: 'free_text',
          required: true,
        },
      ],
    },
  ],
};

function baseArgs(overrides: Record<string, unknown> = {}) {
  return { dimension: 'clarity', structure: STRUCTURE, versionId: 'v1', ...overrides };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'judge-clarity-1',
    entityContext: {
      judgeAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppEvaluateStructureCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppEvaluateStructureCapability — dispatch', () => {
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
      baseArgs({ dimension: 'ordering' }),
      baseContext()
    );

    const data = result.data as { verdict: { dimension: string } };
    expect(data.verdict.dimension).toBe('ordering');
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

    await capabilityDispatcher.dispatch(SLUG, baseArgs({ dimension: 'coverage' }), baseContext());

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'judge-clarity-1',
        operation: CostOperation.CHAT,
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 321,
        outputTokens: 123,
        metadata: expect.objectContaining({
          capability: SLUG,
          dimension: 'coverage',
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
      // Non-string provider/model and a non-array fallbackProviders — every field
      // must be defensively narrowed to the empty binding.
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
    // Parseable JSON, but score is out of range — exercises the schema-invalid branch
    // (issue-path capture) on both the first attempt and the retry.
    const bad = JSON.stringify({ score: 5, findings: [] });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: bad }, { content: bad }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('evaluation_failed');
    // The diagnostic should name the offending field, not just "invalid".
    expect(result.error?.message).toContain('score');
  });

  it('omits agentId and versionId from cost metadata when absent', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ versionId: undefined }),
      baseContext({ agentId: undefined })
    );

    expect(result.success).toBe(true);
    const call = (logCost as Mock).mock.calls[0][0];
    expect(call.agentId).toBeUndefined();
    expect(call.metadata.versionId).toBeUndefined();
    expect(call.metadata.dimension).toBe('clarity');
  });
});
