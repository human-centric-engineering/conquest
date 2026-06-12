/**
 * Unit tests for AppRefineDataSlotCapability.
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion)
 * and cost-logging are mocked at the module boundary. Tests verify:
 * - argument validation via the Zod schema (argsSchema)
 * - happy-path: the single refined slot from completion.value is passed through unwrapped
 * - cost metadata wiring (versionId, agentId, model, provider threaded correctly)
 * - the dataSlotsAgent binding is reused (reasoning tier)
 * - every error branch: no provider, provider unavailable, completion throws (classified)
 * - the refine prompt receives the slot, instructions, and sibling slots
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

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
const { logger } = await import('@/lib/logging');
const { AppRefineDataSlotCapability } =
  await import('@/lib/app/questionnaire/capabilities/refine-data-slot');

type Mock = ReturnType<typeof vi.fn>;

const FAKE_PROVIDER = { name: 'openai', chat: vi.fn() };
const FAKE_RESOLVED = { providerSlug: 'openai', model: 'gpt-4o' };

const VALID_STRUCTURE = {
  goal: 'Understand onboarding friction',
  questions: [
    { key: 'q1', prompt: 'How easy was onboarding?', type: 'scale' },
    { key: 'q2', prompt: 'What slowed you down?', type: 'text' },
  ],
};

const CURRENT_SLOT = {
  name: 'Onboarding ease',
  description: 'How smoothly the user got started.',
  theme: 'Friction',
  questionKeys: ['q1'],
};

const REFINED_SLOT = {
  name: 'Onboarding for enterprise',
  description: 'How smoothly an enterprise buyer got started, including procurement and SSO setup.',
  theme: 'Friction',
  questionKeys: ['q1', 'q2'],
  confidence: 0.88,
};

const FAKE_COMPLETION = {
  value: { slot: REFINED_SLOT },
  tokenUsage: { input: 300, output: 120 },
  costUsd: 0.003,
};

const BASE_CONTEXT = {
  userId: 'u1',
  agentId: 'agent-abc',
  entityContext: {
    dataSlotsAgent: { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
  },
};

const VALID_ARGS = {
  structure: VALID_STRUCTURE,
  slot: CURRENT_SLOT,
  instructions: 'Focus on enterprise buyers and fold in procurement.',
};

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue(FAKE_COMPLETION);
  (logCost as Mock).mockResolvedValue(undefined);
});

describe('AppRefineDataSlotCapability — metadata', () => {
  it('has the correct slug and processesPii=false', () => {
    const cap = new AppRefineDataSlotCapability();
    expect(cap.slug).toBe('app_refine_data_slot');
    expect(cap.processesPii).toBe(false);
  });
});

describe('AppRefineDataSlotCapability — happy path', () => {
  it('returns success with the single refined slot from the completion value', async () => {
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data?.slot).toEqual(REFINED_SLOT);
    // Coverage was re-suggested (q2 added) — "wording + coverage" scope.
    expect(result.data?.slot.questionKeys).toEqual(['q1', 'q2']);
  });

  it('resolves the provider binding from entityContext.dataSlotsAgent at the reasoning tier', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('passes the resolved provider + model into runStructuredCompletion', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(runStructuredCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ provider: FAKE_PROVIDER, model: 'gpt-4o' })
    );
  });

  it('builds a prompt that carries the instructions, the slot, and the question list', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    const messages = (runStructuredCompletion as Mock).mock.calls[0]?.[0]?.messages as {
      role: string;
      content: string;
    }[];
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('Focus on enterprise buyers');
    expect(user).toContain('Onboarding ease');
    expect(user).toContain('[q1]');
    expect(user).toContain('[q2]');
  });

  it('threads versionId and agentId into logCost metadata', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute({ ...VALID_ARGS, versionId: 'v-999' }, BASE_CONTEXT);

    await Promise.resolve();

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-abc',
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 300,
        outputTokens: 120,
        metadata: expect.objectContaining({
          versionId: 'v-999',
          capability: 'app_refine_data_slot',
        }),
      })
    );
  });

  it('omits versionId from logCost metadata when not provided', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    await Promise.resolve();

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ versionId: expect.anything() }),
      })
    );
  });
});

describe('AppRefineDataSlotCapability — error branches', () => {
  it('returns no_provider_configured when resolveAgentProviderAndModel throws', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(logger.error).toHaveBeenCalledWith(
      'refine_data_slot: no provider resolved',
      expect.objectContaining({ agentId: 'agent-abc', error: 'no provider' })
    );
  });

  it('returns provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('provider offline'));
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('classifies an unparseable (likely truncated) schema failure as incomplete_response', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(
      new Error('Data-slot refinement response was not valid against the schema after one retry')
    );
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('incomplete_response');
    expect(logger.error).toHaveBeenCalledWith(
      'refine_data_slot: structured completion failed',
      expect.objectContaining({ model: 'gpt-4o', provider: 'openai' })
    );
  });

  it('classifies a timed-out completion as generation_timeout', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(
      new Error('Request timed out after 60000ms')
    );
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(result.error?.code).toBe('generation_timeout');
  });

  it('does not call runStructuredCompletion when getProvider fails', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('fail'));
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('logs and swallows a rejected logCost promise (fire-and-forget)', async () => {
    (logCost as Mock).mockRejectedValue(new Error('cost log failed'));
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);

    expect(result.success).toBe(true);
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      'refine_data_slot: logCost rejected',
      expect.objectContaining({ error: 'cost log failed' })
    );
  });
});

describe('AppRefineDataSlotCapability — schema validation (argsSchema)', () => {
  it('requires non-empty instructions', () => {
    const cap = new AppRefineDataSlotCapability();
    expect(() =>
      cap.validate({ structure: VALID_STRUCTURE, slot: CURRENT_SLOT, instructions: '' })
    ).toThrow();
  });

  it('requires at least one question in structure', () => {
    const cap = new AppRefineDataSlotCapability();
    expect(() =>
      cap.validate({ structure: { questions: [] }, slot: CURRENT_SLOT, instructions: 'x' })
    ).toThrow();
  });

  it('accepts valid args (with optional versionId and siblingSlots)', () => {
    const cap = new AppRefineDataSlotCapability();
    expect(() =>
      cap.validate({
        ...VALID_ARGS,
        versionId: 'v-1',
        siblingSlots: [{ name: 'Pricing', theme: 'Friction' }],
      })
    ).not.toThrow();
  });
});

describe('AppRefineDataSlotCapability — dataSlotsAgent binding extraction', () => {
  it('falls back to an empty binding when entityContext is missing', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, { userId: null, agentId: 'a1' });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('falls back to an empty binding when dataSlotsAgent is not a record', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, {
      userId: null,
      agentId: 'a1',
      entityContext: { dataSlotsAgent: 'not-a-record' },
    });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('filters non-string values from fallbackProviders and coerces non-string provider/model', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, {
      userId: null,
      agentId: 'a1',
      entityContext: {
        dataSlotsAgent: { provider: 42, model: null, fallbackProviders: [7, 'anthropic', null] },
      },
    });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: ['anthropic'] },
      'reasoning'
    );
  });

  it('falls back to an empty fallbackProviders array when the field is not an array', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, {
      userId: null,
      agentId: 'a1',
      entityContext: {
        dataSlotsAgent: { provider: 'openai', model: 'm1', fallbackProviders: 'nope' },
      },
    });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'm1', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('stringifies a non-Error thrown value as the error message', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue('plain string error');
    const cap = new AppRefineDataSlotCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.error?.message).toBe('plain string error');
  });

  it('does not call getProvider when provider resolution fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('fail'));
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('AppRefineDataSlotCapability — parse / onFinalFailure callback wiring', () => {
  // The parse + onFinalFailure callbacks are passed inline to the (mocked) runStructuredCompletion.
  // Capture them off the call args and invoke directly to exercise the validate/retry branches.
  it('parse callback returns the validated { slot } when the JSON is valid', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ slot: REFINED_SLOT })
    );

    expect(callOpts.parse('{"slot":{}}')).toEqual({ slot: REFINED_SLOT });
  });

  it('parse callback returns null and records issue paths when validation fails', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ slot: { name: '', description: '', theme: '' } })
    );

    expect(callOpts.parse('{"slot":{}}')).toBeNull();
    // …and the recorded issue paths surface in the final-failure error message.
    expect((callOpts.onFinalFailure() as Error).message).toContain('invalid at:');
  });

  it('onFinalFailure returns a schema-context Error even with no recorded issues', async () => {
    const cap = new AppRefineDataSlotCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const err = callOpts.onFinalFailure() as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('not valid against the schema after one retry');
  });
});
