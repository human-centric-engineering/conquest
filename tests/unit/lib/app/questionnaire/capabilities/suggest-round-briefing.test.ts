/**
 * Unit tests for AppSuggestRoundBriefingCapability (round Additional Context, phase 3).
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion) and cost
 * logging are mocked at the module boundary. Tests verify: metadata, the questions land in the
 * prompt, off-pool questionIds degrade to general (null), empty title/content proposals are dropped,
 * cost metadata, and the error branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({
  runStructuredCompletion: vi.fn(),
  tryParseJson: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { runStructuredCompletion } =
  await import('@/lib/orchestration/evaluations/parse-structured');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { AppSuggestRoundBriefingCapability } =
  await import('@/lib/app/questionnaire/capabilities/suggest-round-briefing');

type Mock = ReturnType<typeof vi.fn>;

const FAKE_PROVIDER = { name: 'openai', chat: vi.fn() };
const FAKE_RESOLVED = { providerSlug: 'openai', model: 'gpt-4o' };

function completion(entries: unknown) {
  return { value: { entries }, tokenUsage: { input: 100, output: 50 }, costUsd: 0.001 };
}

const CONTEXT = {
  userId: 'u1',
  agentId: 'agent-1',
  entityContext: {
    composerAgent: { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
  },
};

const ARGS = {
  goal: 'Understand team collaboration',
  questions: [
    { id: 'q1', prompt: 'How do teams share information?', sectionTitle: 'Comms' },
    { id: 'q2', prompt: 'What blocks decisions?', sectionTitle: 'Process' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue(
    completion([{ questionId: 'q1', title: 'Comms tools', content: 'They use Slack + email.' }])
  );
  (logCost as Mock).mockResolvedValue(undefined);
});

describe('metadata', () => {
  it('has the correct slug and processesPii=true', () => {
    const cap = new AppSuggestRoundBriefingCapability();
    expect(cap.slug).toBe('app_suggest_round_briefing');
    expect(cap.processesPii).toBe(true);
  });
});

describe('execute', () => {
  it('lists the questions (with ids) in the prompt and returns the proposals', async () => {
    const cap = new AppSuggestRoundBriefingCapability();
    const result = await cap.execute(ARGS, CONTEXT);
    expect(result.success).toBe(true);
    expect(result.data?.entries).toEqual([
      { questionId: 'q1', title: 'Comms tools', content: 'They use Slack + email.' },
    ]);

    const messages = (runStructuredCompletion as Mock).mock.calls[0][0].messages as {
      role: string;
      content: string;
    }[];
    const system = messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('[id:q1]');
    expect(system).toContain('How do teams share information?');
  });

  it('degrades an off-pool questionId to a general (null) note', async () => {
    (runStructuredCompletion as Mock).mockResolvedValue(
      completion([{ questionId: 'nope', title: 'T', content: 'C' }])
    );
    const cap = new AppSuggestRoundBriefingCapability();
    const result = await cap.execute(ARGS, CONTEXT);
    expect(result.data?.entries[0].questionId).toBeNull();
  });

  it('drops proposals missing a title or content', async () => {
    (runStructuredCompletion as Mock).mockResolvedValue(
      completion([
        { questionId: null, title: '', content: 'no title' },
        { questionId: null, title: 'no content', content: '   ' },
        { questionId: 'q2', title: 'Good', content: 'Kept.' },
      ])
    );
    const cap = new AppSuggestRoundBriefingCapability();
    const result = await cap.execute(ARGS, CONTEXT);
    expect(result.data?.entries).toEqual([{ questionId: 'q2', title: 'Good', content: 'Kept.' }]);
  });

  it('frames the no-source case as prompts to gather background', async () => {
    const cap = new AppSuggestRoundBriefingCapability();
    await cap.execute(ARGS, CONTEXT);
    const system = (runStructuredCompletion as Mock).mock.calls[0][0].messages[0].content as string;
    expect(system).toMatch(/No source material was supplied/i);
  });

  it('logs cost with the capability slug in metadata', async () => {
    const cap = new AppSuggestRoundBriefingCapability();
    await cap.execute(ARGS, CONTEXT);
    expect(logCost as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ capability: 'app_suggest_round_briefing' }),
      })
    );
  });
});

describe('error branches', () => {
  it('returns no_provider_configured when resolution throws', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const cap = new AppSuggestRoundBriefingCapability();
    const result = await cap.execute(ARGS, CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });

  it('returns provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('down'));
    const cap = new AppSuggestRoundBriefingCapability();
    const result = await cap.execute(ARGS, CONTEXT);
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('returns suggest_failed when the completion throws', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('bad json'));
    const cap = new AppSuggestRoundBriefingCapability();
    const result = await cap.execute(ARGS, CONTEXT);
    expect(result.error?.code).toBe('suggest_failed');
  });
});

describe('redactProvenance', () => {
  it('redacts source material + goal and previews the proposal count on success', () => {
    const cap = new AppSuggestRoundBriefingCapability();
    const { args, resultPreview } = cap.redactProvenance(
      { ...ARGS, sourceText: 'Sensitive figures' },
      { success: true, data: { entries: [{ questionId: null, title: 't', content: 'c' }] } }
    );
    const safe = args as Record<string, unknown>;
    expect(safe.questionCount).toBe(2);
    expect(safe.sourceText).not.toBe('Sensitive figures');
    const parsed = JSON.parse(resultPreview) as { data: { count: number } };
    expect(parsed.data.count).toBe(1);
  });
});
