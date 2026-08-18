/**
 * Unit tests for AppDetectScopeCandidacyCapability.execute() (P17.19).
 *
 * Mirrors `analyse-routing.test.ts`'s mock set and shape almost exactly — same LLM-chain
 * boundary (resolveAgentProviderAndModel → getProvider → runStructuredCompletion) and
 * cost-logging mocks. The deltas that matter for THIS capability:
 *  - it resolves the `routing` tier, not `reasoning` (this check runs on every fresh ingestion
 *    and must stay cheap);
 *  - its dispatch-context binding key is `entityContext.candidacyAgent`, not
 *    `routingAnalystAgent`;
 *  - it has its own `redactProvenance` contract: the document text must never leak into the
 *    audit trail, and the result preview must summarise counts rather than quote content.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostOperation } from '@/types/orchestration';

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
const { AppDetectScopeCandidacyCapability } =
  await import('@/lib/app/questionnaire/capabilities/detect-scope-candidacy');

type Mock = ReturnType<typeof vi.fn>;

const FAKE_PROVIDER = { name: 'openai', chat: vi.fn() };
const FAKE_RESOLVED = { providerSlug: 'openai', model: 'gpt-5.4-mini' };

const ARGS = {
  documentText: 'Only ask Section B if the respondent sells through resellers.',
  documentFileName: 'survey.pdf',
  versionId: 'ver-1',
};

const RESULT = {
  isCandidate: true,
  confidence: 0.82,
  signals: [
    {
      note: 'Names a channel-based eligibility rule',
      sourceQuote: 'Only ask Section B if the respondent sells through resellers.',
    },
  ],
  summary: 'The document routes Section B based on channel structure.',
};

const CONTEXT = {
  userId: 'admin-1',
  agentId: 'agent-1',
  entityContext: {
    candidacyAgent: {
      provider: 'openai',
      model: 'gpt-5.4-mini',
      fallbackProviders: ['anthropic'],
    },
  },
};

const capability = new AppDetectScopeCandidacyCapability();

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue({
    value: RESULT,
    tokenUsage: { input: 800, output: 150 },
    costUsd: 0.01,
  });
  (logCost as Mock).mockResolvedValue(undefined);
});

describe('execute — happy path', () => {
  it('returns the candidacy verdict unwrapped', async () => {
    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(true);
    expect(res.data?.result).toEqual(RESULT);
  });

  it('resolves the binding from entityContext.candidacyAgent on the routing tier', async () => {
    await capability.execute(ARGS, CONTEXT);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-5.4-mini', fallbackProviders: ['anthropic'] },
      'routing'
    );
  });

  it('falls back to an empty binding when the dispatch context carries no candidacyAgent', async () => {
    // An empty provider/model is meaningful, not an error: agent-resolver then picks the tier
    // default, matching the seeded agent's provider-agnostic ('') columns.
    await capability.execute(ARGS, { userId: 'admin-1', agentId: 'agent-1' });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'routing'
    );
  });

  it('threads the resolved provider/model, tokens and versionId into the cost log', async () => {
    await capability.execute(ARGS, CONTEXT);
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        model: 'gpt-5.4-mini',
        provider: 'openai',
        operation: CostOperation.CHAT,
        inputTokens: 800,
        outputTokens: 150,
        metadata: expect.objectContaining({
          capability: 'app_detect_adaptive_scope_candidacy',
          versionId: 'ver-1',
        }),
      })
    );
  });

  it('omits versionId from cost metadata when args carries none', async () => {
    const { versionId: _versionId, ...argsWithoutVersion } = ARGS;
    await capability.execute(argsWithoutVersion, CONTEXT);
    const call = (logCost as Mock).mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(call.metadata).not.toHaveProperty('versionId');
  });

  it('does not let a rejected cost log fail the check', async () => {
    // Cost logging is fire-and-forget; a metering blip must not lose a real verdict.
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

  it('returns candidacy_check_failed when the completion throws', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('schema invalid after retry'));

    const res = await capability.execute(ARGS, CONTEXT);
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('candidacy_check_failed');
    expect(res.error?.message).toContain('schema invalid after retry');
  });

  it('threads schema validation issue paths into the final failure message', async () => {
    // Exercise the REAL `parse` closure and `onFinalFailure` builder the capability constructs —
    // only `tryParseJson` and `runStructuredCompletion` are mocked at the boundary. This is what
    // would break if the capability stopped tracking `lastIssuePaths` across parse attempts.
    // Mirrors `analyse-routing.test.ts`'s "threads schema validation issue paths…" test.
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

    // Missing "summary" — fails scopeCandidacySchema validation.
    const malformed = JSON.stringify({ isCandidate: true, confidence: 0.5, signals: [] });
    expect(opts.parse(malformed)).toBeNull();
    expect(opts.onFinalFailure().message).toContain('invalid at: summary');
  });

  it('never logs cost for a failed run', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('boom'));
    await capability.execute(ARGS, CONTEXT);
    expect(logCost).not.toHaveBeenCalled();
  });
});

describe('redactProvenance', () => {
  it('redacts documentText from the safe args — never appears verbatim', () => {
    const { args } = capability.redactProvenance(ARGS, { success: true, data: { result: RESULT } });
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain(ARGS.documentText);
    expect(args).toMatchObject({ documentFileName: 'survey.pdf' });
  });

  it('includes verdict counts but never a raw sourceQuote or summary in the preview', () => {
    const { resultPreview } = capability.redactProvenance(ARGS, {
      success: true,
      data: { result: RESULT },
    });
    const parsed = JSON.parse(resultPreview) as {
      data: { isCandidate: boolean; confidence: number; signalCount: number };
    };
    expect(parsed.data).toEqual({ isCandidate: true, confidence: 0.82, signalCount: 1 });
    expect(resultPreview).not.toContain(RESULT.summary);
    expect(resultPreview).not.toContain(RESULT.signals[0].sourceQuote);
  });
});
