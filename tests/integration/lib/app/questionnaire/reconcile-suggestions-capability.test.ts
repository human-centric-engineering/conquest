/**
 * Integration test for the cross-judge reconciliation capability.
 *
 * Runs through the REAL `capabilityDispatcher` and the REAL `runStructuredCompletion`, with only
 * the provider and the DB-backed registry mocked — the same seam its sibling
 * `evaluate-structure-capability.test.ts` is tested at.
 *
 * Covers the happy path, the arg guard that keeps single-judge questions out, the hallucinated-key
 * filter, and the two failure messages (truncation vs contract violation) that the Clarity judge
 * incident taught us to keep apart.
 *
 * The second block covers what the panel does when its surroundings misbehave: a binding the
 * dispatch context supplied in the wrong shape, a provider that resolves but will not load, and an
 * accounting write that rejects mid-run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

const { prisma } = await import('@/lib/db/client');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { logger } = await import('@/lib/logging');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { AppReconcileSuggestionsCapability } =
  await import('@/lib/app/questionnaire/capabilities/reconcile-suggestions');
const { RECONCILE_SUGGESTIONS_CAPABILITY_SLUG } = await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = RECONCILE_SUGGESTIONS_CAPABILITY_SLUG;

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-reconcile',
    slug: SLUG,
    name: 'Reconcile Judge Suggestions',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Reconcile judge suggestions.',
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

function makeProvider(scripts: { content: string }[]) {
  let turn = 0;
  return {
    chat: vi.fn(async (_messages: unknown, _options: unknown) => {
      const script = scripts[turn] ?? scripts[scripts.length - 1];
      turn++;
      return {
        content: script.content,
        usage: { inputTokens: 200, outputTokens: 80 },
        model: 'test-model',
        finishReason: 'stop' as const,
      };
    }),
  };
}

const TARGET = {
  key: 'q_engagement',
  prompt: 'Do you feel engaged and satisfied with your manager?',
  questionType: 'likert',
  context: 'Q2 · Working life',
  judges: [
    {
      dimension: 'clarity',
      label: 'Clarity Judge',
      severity: 'major',
      proposedChange: 'Split into two questions.',
      rationale: 'Double-barrelled.',
    },
    {
      dimension: 'audience_match',
      label: 'Audience-Match Judge',
      severity: 'minor',
      proposedChange: 'Drop "line manager".',
      rationale: 'Contractors have none.',
    },
  ],
};

const VALID_RESPONSE = JSON.stringify({
  reconciliations: [
    {
      targetKey: 'q_engagement',
      alternatives: [
        {
          prompt: 'How engaged do you feel at work?',
          addresses: ['clarity', 'audience_match'],
          note: 'One ask, no role-specific jargon.',
        },
      ],
      unresolved: ['type_fit'],
    },
  ],
});

function baseArgs(overrides: Record<string, unknown> = {}) {
  return { targets: [TARGET], goal: 'Understand engagement.', versionId: 'v1', ...overrides };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    agentId: 'agent-reconciler',
    entityContext: {
      reconcilerAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppReconcileSuggestionsCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]);
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppReconcileSuggestionsCapability — dispatch', () => {
  it('returns the alternatives, the dimensions each addresses, and what it could not fix', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_RESPONSE }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const { suggestions } = result.data as {
      suggestions: {
        targetKey: string;
        alternatives: { addresses: string[] }[];
        unresolved: string[];
      }[];
    };
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].targetKey).toBe('q_engagement');
    expect(suggestions[0].alternatives[0].addresses).toEqual(['clarity', 'audience_match']);
    // The honest half of the contract: wording cannot fix a wrong answer type, and saying so is
    // what stops the admin reading the rewrite as "all seven judges are now happy".
    expect(suggestions[0].unresolved).toEqual(['type_fit']);
  });

  it('sends every judge’s verdict, and the current wording, in the prompt', async () => {
    const provider = makeProvider([{ content: VALID_RESPONSE }]);
    (getProvider as Mock).mockResolvedValue(provider);

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const messages = provider.chat.mock.calls[0][0] as { role: string; content: string }[];
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('Do you feel engaged and satisfied with your manager?');
    expect(user).toContain('Clarity Judge');
    expect(user).toContain('Audience-Match Judge');
    expect(user).toContain('Understand engagement.');
  });

  it('drops a reconciliation addressed at a key that was never sent', async () => {
    // The prompt forbids inventing keys; this makes it true. An alternative attached to a question
    // nobody flagged would either surface against the wrong question or vanish silently.
    const hallucinated = JSON.stringify({
      reconciliations: [
        JSON.parse(VALID_RESPONSE).reconciliations[0],
        {
          targetKey: 'q_invented',
          alternatives: [{ prompt: 'Made up?', addresses: ['clarity'], note: 'n' }],
          unresolved: [],
        },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: hallucinated }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const { suggestions } = result.data as { suggestions: { targetKey: string }[] };
    expect(suggestions.map((s) => s.targetKey)).toEqual(['q_engagement']);
  });

  it('rejects a target with only one judge at the schema boundary', async () => {
    // Reconciling one opinion with itself is a paid no-op; the caller filters, and this enforces.
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_RESPONSE }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ targets: [{ ...TARGET, judges: [TARGET.judges[0]] }] }),
      baseContext()
    );

    expect(result.success).toBe(false);
  });

  it('repairs a malformed first response via the retry path', async () => {
    const provider = makeProvider([{ content: 'not json' }, { content: VALID_RESPONSE }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('blames truncation, not the schema, when no attempt parsed as JSON', async () => {
    const truncated =
      '{"reconciliations":[{"targetKey":"q_engagement","alternatives":[{"prompt":"How';
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: truncated }, { content: truncated }])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('reconciliation_failed');
    expect(result.error?.message).toContain('truncated');
    expect(result.error?.message).not.toContain('not valid against the schema');
  });

  it('names the invalid field paths when the response is JSON but breaks the contract', async () => {
    const bad = JSON.stringify({
      reconciliations: [{ targetKey: 'q_engagement', alternatives: [] }],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: bad }, { content: bad }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('alternatives');
  });

  it('logs cost with the capability and target count in metadata', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_RESPONSE }]));

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const call = (logCost as Mock).mock.calls[0][0];
    expect(call.operation).toBe(CostOperation.CHAT);
    expect(call.metadata.capability).toBe(SLUG);
    expect(call.metadata.targetCount).toBe(1);
    expect(call.metadata.versionId).toBe('v1');
  });

  it('fails closed when no provider resolves', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });

  it('asks for a budget big enough for a batch of rewrites on a reasoning model', async () => {
    const provider = makeProvider([{ content: VALID_RESPONSE }]);
    (getProvider as Mock).mockResolvedValue(provider);

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const options = provider.chat.mock.calls[0][1] as { maxTokens: number; timeoutMs: number };
    expect(options.maxTokens).toBe(8_192);
    expect(options.timeoutMs).toBe(90_000);
  });
});

describe('AppReconcileSuggestionsCapability — degraded surroundings', () => {
  beforeEach(() => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_RESPONSE }]));
    // `vi.clearAllMocks()` clears call history but keeps implementations, so the rejecting
    // `logCost` below would otherwise leak into whichever test ran after it.
    (logCost as Mock).mockResolvedValue(null);
  });

  /** The binding the capability handed the resolver on the run that just dispatched. */
  function resolvedBinding() {
    return (resolveAgentProviderAndModel as Mock).mock.calls[0][0] as {
      provider: string;
      model: string;
      fallbackProviders: string[];
    };
  }

  it('asks for the system default when the dispatch context carries no reconciler binding', async () => {
    // An unbound capability is the normal case before an admin picks an agent, not an error: the
    // empty binding is what tells the resolver "choose the reasoning-tier default".
    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({ entityContext: {} })
    );

    expect(result.success).toBe(true);
    expect(resolvedBinding()).toEqual({ provider: '', model: '', fallbackProviders: [] });
  });

  it('asks for the system default when the binding is present but not an object', async () => {
    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({ entityContext: { reconcilerAgent: 'gpt-5.4' } })
    );

    expect(result.success).toBe(true);
    expect(resolvedBinding()).toEqual({ provider: '', model: '', fallbackProviders: [] });
  });

  it('drops binding fields that came through in the wrong type rather than forwarding them', async () => {
    // `entityContext` is untyped JSON off a DB row, so a number where a slug belongs is a shape the
    // reader has to survive. Blanking the field falls back to the default; forwarding `42` as a
    // provider slug would fail the lookup further down with a much less obvious message.
    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          reconcilerAgent: { provider: 42, model: null, fallbackProviders: 'openai' },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolvedBinding()).toEqual({ provider: '', model: '', fallbackProviders: [] });
  });

  it('keeps the string fallbacks in a mixed fallback list and drops the rest', async () => {
    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          reconcilerAgent: {
            provider: 'openai',
            model: 'gpt-5.4',
            fallbackProviders: ['anthropic', 7, null, 'groq'],
          },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolvedBinding()).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
      fallbackProviders: ['anthropic', 'groq'],
    });
  });

  it('fails closed with its own code when the provider resolves but will not load', async () => {
    // Distinct from `no_provider_configured`: the binding was fine and a provider was named, so the
    // fix is on the provider (missing key, disabled row), not on the agent's configuration.
    (getProvider as Mock).mockRejectedValue(new Error('provider disabled'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(result.error?.message).toContain('provider disabled');
  });

  it('reports a non-Error rejection as its string form instead of losing it', async () => {
    // An SDK that rejects with a bare string would otherwise surface as "undefined" — the message
    // is the only thing the admin sees on a failed run.
    (resolveAgentProviderAndModel as Mock).mockRejectedValue('upstream said no');

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(result.error?.message).toBe('upstream said no');
  });

  it('still returns the reconciliation when the cost write rejects', async () => {
    // Cost is fire-and-forget by design: an accounting failure must not throw away LLM work the
    // admin has already paid for. It is logged, not swallowed silently.
    (logCost as Mock).mockRejectedValue(new Error('cost table unreachable'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'reconcile_suggestions: logCost rejected',
        expect.objectContaining({ error: 'cost table unreachable' })
      );
    });
  });

  it('omits the optional cost dimensions rather than logging them as undefined', async () => {
    // A run dispatched outside an agent, on a version-less preview, must not write `agentId: undefined`
    // into the cost row — an absent key and a present-but-empty one read differently in the ledger.
    await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ versionId: undefined }),
      baseContext({ agentId: undefined })
    );

    const call = (logCost as Mock).mock.calls[0][0];
    expect(call).not.toHaveProperty('agentId');
    expect(call.metadata).not.toHaveProperty('versionId');
    expect(call.metadata.targetCount).toBe(1);
  });

  it('tells the model the goal and audience are missing rather than sending an empty field', async () => {
    const provider = makeProvider([{ content: VALID_RESPONSE }]);
    (getProvider as Mock).mockResolvedValue(provider);

    await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ goal: undefined, audience: undefined }),
      baseContext()
    );

    const messages = provider.chat.mock.calls[0][0] as { role: string; content: string }[];
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('(no goal specified)');
    expect(user).toContain('(no audience specified)');
  });

  it('says "(root)" when the response is the wrong shape entirely, not an empty path', async () => {
    // A bare scalar parses as JSON, so this is a contract violation rather than truncation — and the
    // failing path is the document itself. Reporting it as `` would read as "invalid at: ".
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: '5' }, { content: '5' }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('not valid against the schema');
    expect(result.error?.message).toContain('(root)');
  });
});
