/**
 * Integration test for the questionnaire completion-offer composer capability (F4.5).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion`, with only the provider (and the DB-backed registry /
 * binding lookups) mocked — the same seam the other questionnaire capabilities are
 * tested at.
 *
 * Covers: happy path, the optional remainingNote, malformed-JSON repair (retry),
 * no-silent-failure on final parse failure, cost logging + isolation, provider
 * resolution + fail-closed paths, binding coercion, and the counts-only
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
const { AppComposeCompletionOfferCapability } =
  await import('@/lib/app/questionnaire/capabilities/compose-completion-offer');
const { COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG } =
  await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Compose Completion Offer',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Compose completion offer.',
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

/** A schema-valid offer with the optional remainingNote present. */
const VALID_OFFER = {
  offerMessage: 'It looks like we have everything we need — shall I submit your answers?',
  coveredSummary: 'We covered your goals, timeline, and budget.',
  remainingNote: 'You can still add anything else before we wrap up.',
};
const VALID_JSON = JSON.stringify(VALID_OFFER);

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    coverage: 1,
    answeredCount: 3,
    capReached: false,
    coveredSlots: [
      { key: 'goal', prompt: 'What is your goal?' },
      { key: 'budget', prompt: 'What is your budget?' },
    ],
    remainingSlots: [],
    recentMessages: ['I think that covers it'],
    sessionId: 'sess-1',
    ...overrides,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    entityContext: {
      completionAgent: { provider: '', model: '', fallbackProviders: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppComposeCompletionOfferCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppComposeCompletionOfferCapability — dispatch', () => {
  it('returns the composed offer on the happy path', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      offer: { offerMessage: string; coveredSummary: string; remainingNote?: string };
    };
    expect(data.offer.offerMessage).toContain('submit');
    expect(data.offer.coveredSummary).toContain('goals');
    expect(data.offer.remainingNote).toBe('You can still add anything else before we wrap up.');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('omits remainingNote when the model does not return one', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([
        { content: JSON.stringify({ offerMessage: 'Ready?', coveredSummary: 'All set.' }) },
      ])
    );

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as { offer: { remainingNote?: string } };
    expect(data.offer.remainingNote).toBeUndefined();
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
        metadata: expect.objectContaining({ capability: SLUG, sessionId: 'sess-1' }),
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

  it('surfaces composition_failed (no silent fallback) when both attempts fail to parse', async () => {
    const provider = makeProvider([{ content: 'nope' }, { content: 'still nope' }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('composition_failed');
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid args (coverage out of range) at the dispatcher boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ coverage: 2 }),
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

  it('still succeeds when cost logging rejects (accounting failure is isolated)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));
    (logCost as Mock).mockRejectedValueOnce(new Error('cost DB down'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'compose_completion_offer: logCost rejected',
        expect.objectContaining({ error: 'cost DB down' })
      )
    );
  });

  it('coerces a malformed completion-agent binding from context to safe types', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          completionAgent: {
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

  it('defaults fallbackProviders to [] when the binding value is not an array', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          completionAgent: { provider: 'p', model: 'm', fallbackProviders: 'nope' },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'p', model: 'm', fallbackProviders: [] },
      'chat'
    );
  });

  it('retries on a schema-invalid (but JSON) first response, then succeeds', async () => {
    // Valid JSON, invalid schema (missing coveredSummary) → the issue-path map runs
    // (paths surface in the final error + logs), then a valid retry succeeds.
    const badSchema = JSON.stringify({ offerMessage: 'hi' });
    const provider = makeProvider([{ content: badSchema }, { content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('surfaces composition_failed naming the invalid paths when both attempts fail schema', async () => {
    // Both responses are valid JSON but schema-invalid → onFinalFailure runs with a
    // non-empty lastIssuePaths, exercising the named-paths branch of the error message.
    const badSchema = JSON.stringify({ offerMessage: 'hi' });
    const provider = makeProvider([{ content: badSchema }, { content: badSchema }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('composition_failed');
  });

  it('coerces a non-Error throw to a string message (provider_unavailable)', async () => {
    // getProvider rejecting with a non-Error exercises errorMessage's String(err) branch.
    (getProvider as Mock).mockRejectedValueOnce('provider blew up');

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(result.error?.message).toBe('provider blew up');
  });

  it('logs cost without an agentId, and without a sessionId in metadata, when both are omitted', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ sessionId: undefined }),
      baseContext({ agentId: undefined })
    );

    const chatCall = (logCost as Mock).mock.calls.find(
      ([arg]) => arg?.metadata?.capability === SLUG
    );
    expect(chatCall, 'a CHAT cost log for this capability should have been emitted').toBeDefined();
    // Non-null after the guard so a regression points at these lines, not a silent ?. no-op.
    const chatArg = chatCall![0];
    expect(chatArg).toMatchObject({
      operation: CostOperation.CHAT,
      metadata: { capability: SLUG },
    });
    expect(chatArg).not.toHaveProperty('agentId');
    expect(chatArg.metadata).not.toHaveProperty('sessionId');
  });
});

describe('AppComposeCompletionOfferCapability — redactProvenance', () => {
  const capability = new AppComposeCompletionOfferCapability();

  it('redacts the recent messages and emits a PII-safe, counts-only preview', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: { offer: VALID_OFFER },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs.coveredSlotCount).toBe(2);
    expect(safeArgs.recentMessageCount).toBe(1);
    expect(safeArgs.coverage).toBe(1);
    expect(String(safeArgs.recentMessages)).toContain('redacted');
    // The preview leaks no offer text (which reproduces the recap) — flags only.
    expect(redaction.resultPreview).not.toContain('submit');
    expect(redaction.resultPreview).not.toContain('goals');
    expect(redaction.resultPreview).toContain('hasOffer');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
    const preview = JSON.parse(redaction.resultPreview) as {
      data: { hasOffer: boolean; hasRemainingNote: boolean };
    };
    expect(preview.data.hasOffer).toBe(true);
    expect(preview.data.hasRemainingNote).toBe(true);
  });

  it('passes an error envelope through the preview untouched', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'composition_failed', message: 'boom' },
    });
    expect(redaction.resultPreview).toContain('composition_failed');
  });

  it('caps an over-long error preview at 200 chars with an ellipsis', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'composition_failed', message: 'x'.repeat(500) },
    });
    expect(redaction.resultPreview.length).toBe(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });

  it('omits an absent sessionId from the persisted args', () => {
    const args = baseArgs({ sessionId: undefined }) as Parameters<
      typeof capability.redactProvenance
    >[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: { offer: VALID_OFFER },
    });

    expect(redaction.args as Record<string, unknown>).not.toHaveProperty('sessionId');
  });
});
