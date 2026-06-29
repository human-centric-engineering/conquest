/**
 * Unit tests for AppAuthorIntroBackgroundCapability (F12.2).
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion) and cost
 * logging are mocked at the module boundary. Tests verify: metadata, generate vs refine prompt
 * wiring, trim + length cap on the output, cost metadata (mode), and every error branch.
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
const { AppAuthorIntroBackgroundCapability } =
  await import('@/lib/app/questionnaire/capabilities/author-intro-background');
const { INTRO_BACKGROUND_MAX_LENGTH } = await import('@/lib/app/questionnaire/types');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

type Mock = ReturnType<typeof vi.fn>;

const FAKE_PROVIDER = { name: 'openai', chat: vi.fn() };
const FAKE_RESOLVED = { providerSlug: 'openai', model: 'gpt-4o' };

function completion(background: string) {
  return { value: { background }, tokenUsage: { input: 100, output: 50 }, costUsd: 0.001 };
}

const CONTEXT = {
  userId: 'u1',
  agentId: 'agent-1',
  entityContext: {
    composerAgent: { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue(completion('Generated intro.'));
  (logCost as Mock).mockResolvedValue(undefined);
});

describe('AppAuthorIntroBackgroundCapability — metadata', () => {
  it('has the correct slug and processesPii=true', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    expect(cap.slug).toBe('app_author_intro_background');
    expect(cap.processesPii).toBe(true);
  });
});

describe('generate', () => {
  it('returns the generated background and passes the brief to the prompt', async () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute(
      { mode: 'generate', brief: 'Acme team survey about collaboration' },
      CONTEXT
    );
    expect(result.success).toBe(true);
    expect(result.data?.background).toBe('Generated intro.');

    const messages = (runStructuredCompletion as Mock).mock.calls[0][0].messages as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('Acme team survey about collaboration');
  });

  it('folds questionnaireContext into the generate prompt when supplied', async () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    await cap.execute(
      {
        mode: 'generate',
        brief: 'Acme team survey',
        questionnaireContext: 'Goal of this questionnaire:\nUnderstand collaboration',
      },
      CONTEXT
    );

    const messages = (runStructuredCompletion as Mock).mock.calls[0][0].messages as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('Acme team survey');
    expect(userMsg.content).toContain('Understand collaboration');
  });
});

describe('refine', () => {
  it('returns the refined background and passes current text + instruction to the prompt', async () => {
    (runStructuredCompletion as Mock).mockResolvedValue(completion('Shorter intro.'));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute(
      { mode: 'refine', currentText: 'The original long text', instruction: 'Make it shorter' },
      CONTEXT
    );
    expect(result.success).toBe(true);
    expect(result.data?.background).toBe('Shorter intro.');

    const messages = (runStructuredCompletion as Mock).mock.calls[0][0].messages as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('The original long text');
    expect(userMsg.content).toContain('Make it shorter');
  });
});

describe('output normalisation', () => {
  it('trims the model output', async () => {
    (runStructuredCompletion as Mock).mockResolvedValue(completion('   padded   '));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute({ mode: 'generate', brief: 'x' }, CONTEXT);
    expect(result.data?.background).toBe('padded');
  });

  it('caps the output at INTRO_BACKGROUND_MAX_LENGTH', async () => {
    (runStructuredCompletion as Mock).mockResolvedValue(
      completion('a'.repeat(INTRO_BACKGROUND_MAX_LENGTH + 500))
    );
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute({ mode: 'generate', brief: 'x' }, CONTEXT);
    expect(result.data?.background).toHaveLength(INTRO_BACKGROUND_MAX_LENGTH);
  });

  it('logs cost with the mode in metadata', async () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    await cap.execute({ mode: 'generate', brief: 'x' }, CONTEXT);
    expect(logCost as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ mode: 'generate' }),
      })
    );
  });
});

describe('error branches', () => {
  it('returns no_provider_configured when resolution throws', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute({ mode: 'generate', brief: 'x' }, CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });

  it('returns provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('down'));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute({ mode: 'generate', brief: 'x' }, CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('returns authoring_failed when the completion throws', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('bad json'));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute({ mode: 'generate', brief: 'x' }, CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('authoring_failed');
  });
});

describe('redactProvenance', () => {
  it('redacts brief for a generate invocation and previews the background length on success', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    const args = { mode: 'generate' as const, brief: 'Sensitive company context' };
    const result = { success: true as const, data: { background: 'some text' } };

    const { args: safeArgs, resultPreview } = cap.redactProvenance(args, result);

    // mode is preserved
    expect((safeArgs as Record<string, unknown>).mode).toBe('generate');
    // brief is NOT the original plaintext
    expect((safeArgs as Record<string, unknown>).brief).not.toBe('Sensitive company context');
    // preview encodes the length, not the raw background
    const parsed = JSON.parse(resultPreview) as { success: boolean; data: { length: number } };
    expect(parsed.success).toBe(true);
    expect(parsed.data.length).toBe('some text'.length);
    expect(resultPreview).not.toContain('some text');
  });

  it('redacts questionnaireContext when present', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    const args = {
      mode: 'generate' as const,
      brief: 'a brief',
      questionnaireContext: 'Goal: secret internal strategy',
    };
    const result = { success: true as const, data: { background: 'text' } };

    const { args: safeArgs } = cap.redactProvenance(args, result);

    expect((safeArgs as Record<string, unknown>).questionnaireContext).not.toBe(
      'Goal: secret internal strategy'
    );
    expect((safeArgs as Record<string, unknown>).questionnaireContext).toBeDefined();
  });

  it('redacts currentText and instruction for a refine invocation on success', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    const args = {
      mode: 'refine' as const,
      currentText: 'Original PII text',
      instruction: 'Shorten it',
    };
    const result = { success: true as const, data: { background: 'shorter' } };

    const { args: safeArgs, resultPreview } = cap.redactProvenance(args, result);

    expect((safeArgs as Record<string, unknown>).mode).toBe('refine');
    expect((safeArgs as Record<string, unknown>).currentText).not.toBe('Original PII text');
    expect((safeArgs as Record<string, unknown>).instruction).not.toBe('Shorten it');
    const parsed = JSON.parse(resultPreview) as { success: boolean; data: { length: number } };
    expect(parsed.data.length).toBe('shorter'.length);
  });

  it('serialises the full result object as the preview when the result is an error', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    const args = { mode: 'generate' as const, brief: 'anything' };
    const errorResult = {
      success: false as const,
      error: { code: 'no_provider_configured', message: 'no provider' },
    };

    const { resultPreview } = cap.redactProvenance(args, errorResult);

    const parsed = JSON.parse(resultPreview) as { success: boolean };
    expect(parsed.success).toBe(false);
    expect(resultPreview).toContain('no_provider_configured');
  });

  it('truncates the preview to 200 chars ending with an ellipsis when it exceeds the cap', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    const args = { mode: 'generate' as const, brief: 'anything' };
    const errorResult = {
      success: false as const,
      error: { code: 'authoring_failed', message: 'x'.repeat(500) },
    };

    const { resultPreview } = cap.redactProvenance(args, errorResult);

    expect(resultPreview.length).toBe(200);
    expect(resultPreview.endsWith('…')).toBe(true);
  });
});

describe('argsSchema superRefine — validation via cap.validate()', () => {
  it('throws CapabilityValidationError when mode is generate but brief is absent', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    expect(() => cap.validate({ mode: 'generate' })).toThrow(CapabilityValidationError);
  });

  it('throws CapabilityValidationError when mode is refine but currentText is absent', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    expect(() => cap.validate({ mode: 'refine', instruction: 'do something' })).toThrow(
      CapabilityValidationError
    );
  });

  it('throws CapabilityValidationError when mode is refine but instruction is absent', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    expect(() => cap.validate({ mode: 'refine', currentText: 'existing text' })).toThrow(
      CapabilityValidationError
    );
  });

  it('accepts valid generate args without throwing', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    expect(() => cap.validate({ mode: 'generate', brief: 'a brief' })).not.toThrow();
  });

  it('accepts valid refine args without throwing', () => {
    const cap = new AppAuthorIntroBackgroundCapability();
    expect(() =>
      cap.validate({ mode: 'refine', currentText: 'existing', instruction: 'shorten' })
    ).not.toThrow();
  });
});

describe('readComposerAgentBinding — non-record fallback', () => {
  it('returns no_provider_configured when composerAgent is null (falls back to empty binding)', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider slug'));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute(
      { mode: 'generate', brief: 'anything' },
      {
        userId: 'u1',
        agentId: 'agent-1',
        entityContext: { composerAgent: null },
      }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });

  it('returns no_provider_configured when composerAgent is a plain string (falls back to empty binding)', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider slug'));
    const cap = new AppAuthorIntroBackgroundCapability();
    const result = await cap.execute(
      { mode: 'generate', brief: 'anything' },
      {
        userId: 'u1',
        agentId: 'agent-1',
        entityContext: { composerAgent: 'openai/gpt-4o' },
      }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });
});
