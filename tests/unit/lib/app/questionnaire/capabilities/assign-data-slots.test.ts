/**
 * Unit tests for AppAssignDataSlotsCapability.
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion) and
 * cost-logging are mocked at the module boundary. Tests verify argument validation, the happy-path
 * placements passthrough, cost metadata wiring, the reused dataSlotsAgent binding (reasoning tier),
 * every error branch, and that the prompt carries the existing slots + the orphan questions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({
  tryParseJson: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));

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
const { AppAssignDataSlotsCapability } =
  await import('@/lib/app/questionnaire/capabilities/assign-data-slots');

type Mock = ReturnType<typeof vi.fn>;

const FAKE_PROVIDER = { name: 'openai', chat: vi.fn() };
const FAKE_RESOLVED = { providerSlug: 'openai', model: 'gpt-4o' };

const VALID_STRUCTURE = {
  goal: 'Understand onboarding friction',
  questions: [
    { key: 'q1', prompt: 'How easy was onboarding?', type: 'scale' },
    { key: 'q2', prompt: 'What slowed you down?', type: 'text' },
    { key: 'q_budget', prompt: 'What is your budget?', type: 'numeric' },
  ],
};

const EXISTING_SLOTS = [
  {
    key: 'onboarding_ease',
    name: 'Onboarding ease',
    theme: 'Friction',
    description: 'How smoothly the user got started.',
    questionKeys: ['q1', 'q2'],
  },
];

const PLACEMENTS = [
  {
    questionKey: 'q_budget',
    target: { kind: 'new', name: 'Budget', description: 'Spend available.', theme: 'Money' },
  },
];

const FAKE_COMPLETION = {
  value: { placements: PLACEMENTS },
  tokenUsage: { input: 320, output: 90 },
  costUsd: 0.002,
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
  existingSlots: EXISTING_SLOTS,
  orphanQuestionKeys: ['q_budget'],
};

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue(FAKE_COMPLETION);
  (logCost as Mock).mockResolvedValue(undefined);
});

describe('AppAssignDataSlotsCapability — metadata', () => {
  it('has the correct slug and processesPii=false', () => {
    const cap = new AppAssignDataSlotsCapability();
    expect(cap.slug).toBe('app_assign_data_slots');
    expect(cap.processesPii).toBe(false);
  });
});

describe('AppAssignDataSlotsCapability — happy path', () => {
  it('returns success with the placements from the completion value', async () => {
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.success).toBe(true);
    expect(result.data?.placements).toEqual(PLACEMENTS);
  });

  it('resolves the provider binding from entityContext.dataSlotsAgent at the reasoning tier', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('builds a prompt carrying the existing slots and the orphan questions', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    const messages = (runStructuredCompletion as Mock).mock.calls[0]?.[0]?.messages as {
      role: string;
      content: string;
    }[];
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('Onboarding ease'); // existing slot
    expect(user).toContain('onboarding_ease'); // its key
    expect(user).toContain('What is your budget?'); // the orphan question prompt
  });

  it('threads versionId and agentId into logCost metadata', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute({ ...VALID_ARGS, versionId: 'v-999' }, BASE_CONTEXT);
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-abc',
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 320,
        outputTokens: 90,
        metadata: expect.objectContaining({
          versionId: 'v-999',
          capability: 'app_assign_data_slots',
        }),
      })
    );
  });

  it('omits versionId from logCost metadata when not provided', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ versionId: expect.anything() }),
      })
    );
  });
});

describe('AppAssignDataSlotsCapability — error branches', () => {
  it('returns no_provider_configured when resolveAgentProviderAndModel throws', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
  });

  it('returns provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('provider offline'));
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('classifies a timed-out completion as generation_timeout', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(
      new Error('Request timed out after 90000ms')
    );
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.error?.code).toBe('generation_timeout');
  });

  it('does not call runStructuredCompletion when getProvider fails', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('fail'));
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('logs and swallows a rejected logCost promise (fire-and-forget)', async () => {
    (logCost as Mock).mockRejectedValue(new Error('cost log failed'));
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.success).toBe(true);
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      'assign_data_slots: logCost rejected',
      expect.objectContaining({ error: 'cost log failed' })
    );
  });
});

describe('AppAssignDataSlotsCapability — schema validation (argsSchema)', () => {
  it('requires at least one orphan question key', () => {
    const cap = new AppAssignDataSlotsCapability();
    expect(() =>
      cap.validate({
        structure: VALID_STRUCTURE,
        existingSlots: EXISTING_SLOTS,
        orphanQuestionKeys: [],
      })
    ).toThrow();
  });

  it('requires at least one question in structure', () => {
    const cap = new AppAssignDataSlotsCapability();
    expect(() =>
      cap.validate({ structure: { questions: [] }, existingSlots: [], orphanQuestionKeys: ['q1'] })
    ).toThrow();
  });

  it('accepts valid args with an empty existing-slot set', () => {
    const cap = new AppAssignDataSlotsCapability();
    expect(() =>
      cap.validate({
        structure: VALID_STRUCTURE,
        existingSlots: [],
        orphanQuestionKeys: ['q_budget'],
      })
    ).not.toThrow();
  });
});

describe('AppAssignDataSlotsCapability — dataSlotsAgent binding extraction', () => {
  it('falls back to an empty binding when entityContext is missing', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, { userId: null, agentId: 'a1' });
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('falls back to an empty binding when dataSlotsAgent is not a record', async () => {
    const cap = new AppAssignDataSlotsCapability();
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

  it('filters non-string fallbackProviders and coerces non-string provider/model', async () => {
    const cap = new AppAssignDataSlotsCapability();
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
    const cap = new AppAssignDataSlotsCapability();
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
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.error?.message).toBe('plain string error');
  });

  it('does not call getProvider when provider resolution fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('fail'));
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('classifies an unparseable schema failure as incomplete_response', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(
      new Error('Data-slot assignment response was not valid against the schema after one retry')
    );
    const cap = new AppAssignDataSlotsCapability();
    const result = await cap.execute(VALID_ARGS, BASE_CONTEXT);
    expect(result.error?.code).toBe('incomplete_response');
  });
});

describe('AppAssignDataSlotsCapability — parse / onFinalFailure callback wiring', () => {
  it('parse callback returns the validated { placements } when the JSON is valid', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ placements: PLACEMENTS })
    );
    expect(callOpts.parse('{"placements":[]}')).toEqual({ placements: PLACEMENTS });
  });

  it('parse callback returns null and records issue paths when validation fails', async () => {
    const cap = new AppAssignDataSlotsCapability();
    await cap.execute(VALID_ARGS, BASE_CONTEXT);
    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ placements: [{ questionKey: '', target: { kind: 'bogus' } }] })
    );
    expect(callOpts.parse('{}')).toBeNull();
    expect((callOpts.onFinalFailure() as Error).message).toContain('invalid at:');
  });
});
