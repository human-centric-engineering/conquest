/**
 * Unit tests for AppAnalyseRoutingCapability.execute() (P17.4).
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion) and
 * cost-logging are mocked at the module boundary. Mirrors the depth the sibling capability's
 * tests establish (`analyse-glossary-terms.test.ts`): every error branch gets its own outcome
 * code, the agent binding actually reaches the resolver, and cost metadata is threaded.
 *
 * The error codes matter because the SSE route surfaces them verbatim to the admin and records
 * them on the AppAiRun — a branch that returned the wrong code would mislabel a failure in the
 * audit trail, which is precisely the thing provenance exists to prevent.
 *
 * `redactProvenance` is covered separately in `analyse-routing-redaction.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({ tryParseJson: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { runStructuredCompletion } = await import('@/lib/orchestration/llm/structured-completion');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { logger } = await import('@/lib/logging');
const { AppAnalyseRoutingCapability } =
  await import('@/lib/app/questionnaire/capabilities/analyse-routing');

type Mock = ReturnType<typeof vi.fn>;

const FAKE_PROVIDER = { name: 'openai', chat: vi.fn() };
const FAKE_RESOLVED = { providerSlug: 'openai', model: 'gpt-5.4' };

const ARGS = {
  questions: [{ key: 'q1', prompt: 'How many partners does your firm work through?' }],
  goal: 'Assess channel readiness',
  versionId: 'ver-1',
};

const RESULT = {
  topics: [
    {
      key: 'partner_channel',
      label: 'Partner channel',
      phase: 'conditional' as const,
      criteria: 'They sell through partners or resellers',
      depth: 'full' as const,
      questionKeys: ['q1'],
      dataSlotKeys: [],
      rationale: 'The document routes on channel structure.',
      sourceQuote:
        'Only ask the Partner Channel section if the respondent sells through resellers.',
    },
    {
      key: 'core_ops',
      label: 'Core operations',
      phase: 'core' as const,
      criteria: null,
      depth: 'full' as const,
      questionKeys: [],
      dataSlotKeys: [],
      rationale: 'Runs for everyone.',
    },
  ],
  rules: [],
  summary: 'Found one conditional section gated on channel structure.',
  fromDocument: true,
};

const CONTEXT = {
  userId: 'admin-1',
  agentId: 'agent-1',
  entityContext: {
    routingAnalystAgent: {
      provider: 'openai',
      model: 'gpt-5.4',
      fallbackProviders: ['anthropic'],
    },
  },
};

const capability = new AppAnalyseRoutingCapability();

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue({
    value: RESULT,
    tokenUsage: { input: 4000, output: 900 },
    costUsd: 0.05,
  });
});

describe('execute — happy path', () => {
  it('returns the analyst proposal unwrapped', async () => {
    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(true);
    expect(res.data?.result).toEqual(RESULT);
  });

  it('resolves the binding from entityContext on the reasoning tier', async () => {
    await capability.execute(ARGS, CONTEXT);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-5.4', fallbackProviders: ['anthropic'] },
      'reasoning'
    );
  });

  it('falls back to an empty binding when the dispatch context carries none', async () => {
    // An empty provider/model is meaningful, not an error: agent-resolver then picks the tier
    // default, which is how the seeded agent (empty provider/model) is meant to resolve.
    await capability.execute(ARGS, { userId: 'admin-1', agentId: 'agent-1' });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('threads the resolved provider/model, tokens and versionId into the cost log', async () => {
    await capability.execute(ARGS, CONTEXT);
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        model: 'gpt-5.4',
        provider: 'openai',
        inputTokens: 4000,
        outputTokens: 900,
        metadata: expect.objectContaining({
          capability: 'app_analyse_routing',
          versionId: 'ver-1',
        }),
      })
    );
  });

  it('sends the questions and goal to the completion as a built prompt', async () => {
    await capability.execute(ARGS, CONTEXT);
    const opts = (runStructuredCompletion as Mock).mock.calls[0][0];
    const rendered = opts.messages.map((m: { content: string }) => m.content).join('\n');
    expect(rendered).toContain('How many partners does your firm work through?');
    expect(rendered).toContain('Assess channel readiness');
  });

  it('does not let a rejected cost log fail the analysis', async () => {
    // Cost logging is fire-and-forget; a metering blip must not lose the admin's proposals.
    (logCost as Mock).mockRejectedValue(new Error('metering down'));
    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(true);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
  });
});

describe('execute — error branches', () => {
  it('returns no_provider_configured when the binding resolves to nothing', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no default model'));

    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('no_provider_configured');
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('returns provider_unavailable when the provider cannot be constructed', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('missing OPENAI_API_KEY'));

    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('provider_unavailable');
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns routing_analysis_failed when the completion throws', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('schema invalid after retry'));

    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('routing_analysis_failed');
    expect(res.error?.message).toContain('schema invalid after retry');
  });

  it('threads schema validation issue paths into the final failure message and the log', async () => {
    // Exercise the REAL `parse` closure and `onFinalFailure` builder the capability constructs —
    // only `tryParseJson` and `runStructuredCompletion` are mocked at the boundary. This is what
    // would break if the capability stopped tracking `lastIssuePaths` across parse attempts.
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    (tryParseJson as Mock).mockImplementation((raw: string, cb: (parsed: unknown) => unknown) =>
      cb(JSON.parse(raw))
    );
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('placeholder failure'));

    await capability.execute(ARGS, CONTEXT);

    // Capture the real `opts` the capability built and passed to runStructuredCompletion.
    const opts = (runStructuredCompletion as Mock).mock.calls[0][0] as {
      parse: (raw: string) => unknown;
      onFinalFailure: () => Error;
    };

    // Missing "rationale" on the topic — fails routingAnalysisSchema validation.
    const malformed = JSON.stringify({
      topics: [{ key: 'x', label: 'X', phase: 'core', depth: 'full' }],
      rules: [],
      summary: 's',
      fromDocument: false,
    });
    expect(opts.parse(malformed)).toBeNull();
    expect(opts.onFinalFailure().message).toContain('invalid at: topics.0.rationale');

    // The same lastIssuePaths captured above is what the outer catch block logs when the
    // completion ultimately throws.
    const res = await capability.execute(ARGS, CONTEXT);
    expect(logger.error).toHaveBeenCalledWith(
      'analyse_routing: structured completion failed',
      expect.objectContaining({ error: 'placeholder failure' })
    );
    expect(res.error?.code).toBe('routing_analysis_failed');
  });

  it('stringifies a non-Error rejection rather than losing the reason', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue('provider returned 502');

    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.error?.message).toContain('provider returned 502');
  });

  it('never logs cost for a failed run', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('boom'));
    await capability.execute(ARGS, CONTEXT);
    expect(logCost).not.toHaveBeenCalled();
  });
});
