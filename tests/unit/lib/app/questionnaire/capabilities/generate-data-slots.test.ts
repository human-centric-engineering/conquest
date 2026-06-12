/**
 * Unit tests for AppGenerateDataSlotsCapability.
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion)
 * and cost-logging are all mocked at the module boundary. Tests verify:
 * - argument validation via the Zod schema (argsSchema)
 * - happy-path: slot array returned from completion.value is passed through unwrapped
 * - cost metadata wiring (versionId, agentId, model, provider threaded correctly)
 * - every error branch: no provider, provider unavailable, completion throws
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
const { AppGenerateDataSlotsCapability } =
  await import('@/lib/app/questionnaire/capabilities/generate-data-slots');
const { classifyGenerationFailure } = await import('@/lib/app/questionnaire/data-slots');

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

const FAKE_SLOTS = [
  {
    name: 'Onboarding ease',
    description: 'How smoothly the user got started.',
    theme: 'Friction',
    questionKeys: ['q1'],
    confidence: 0.9,
  },
  {
    name: 'Blocker',
    description: 'What prevented progress.',
    theme: 'Friction',
    questionKeys: ['q2'],
    confidence: 0.8,
  },
];

const FAKE_COMPLETION = {
  value: { slots: FAKE_SLOTS },
  tokenUsage: { input: 400, output: 200 },
  costUsd: 0.005,
};

const BASE_CONTEXT = {
  userId: 'u1',
  agentId: 'agent-abc',
  entityContext: {
    dataSlotsAgent: { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
  (getProvider as Mock).mockResolvedValue(FAKE_PROVIDER);
  (runStructuredCompletion as Mock).mockResolvedValue(FAKE_COMPLETION);
  (logCost as Mock).mockResolvedValue(undefined);
});

describe('AppGenerateDataSlotsCapability — metadata', () => {
  it('has the correct slug and processesPii=false', () => {
    const cap = new AppGenerateDataSlotsCapability();
    expect(cap.slug).toBe('app_generate_data_slots');
    expect(cap.processesPii).toBe(false);
  });
});

describe('AppGenerateDataSlotsCapability — happy path', () => {
  it('returns success with the slot array from the completion value', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(true);
    // The capability wraps the completion's slots array — not the full completion object.
    expect(result.data?.slots).toEqual(FAKE_SLOTS);
    expect(result.data?.slots).toHaveLength(2);
    expect(result.data?.slots[0]?.name).toBe('Onboarding ease');
  });

  it('resolves the provider binding from entityContext.dataSlotsAgent', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('calls getProvider with the resolved provider slug', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(getProvider).toHaveBeenCalledWith('openai');
  });

  it('passes the resolved provider + model into runStructuredCompletion', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(runStructuredCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: FAKE_PROVIDER,
        model: 'gpt-4o',
      })
    );
  });

  it('threads versionId and agentId into logCost metadata', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE, versionId: 'v-999' }, BASE_CONTEXT);

    // Allow the fire-and-forget void logCost to settle.
    await vi.runAllTimersAsync().catch(() => undefined);
    await Promise.resolve();

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-abc',
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 400,
        outputTokens: 200,
        metadata: expect.objectContaining({
          versionId: 'v-999',
          capability: 'app_generate_data_slots',
        }),
      })
    );
  });

  it('omits versionId from logCost metadata when not provided', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    await Promise.resolve();

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ versionId: expect.anything() }),
      })
    );
  });
});

describe('AppGenerateDataSlotsCapability — dataSlotsAgent binding extraction', () => {
  it('falls back to empty binding when entityContext is missing', async () => {
    (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, { userId: null, agentId: 'a1' });

    // Should still call resolver with a safe empty binding rather than crashing.
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('falls back to empty binding when dataSlotsAgent is not a record', async () => {
    (resolveAgentProviderAndModel as Mock).mockResolvedValue(FAKE_RESOLVED);
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute(
      { structure: VALID_STRUCTURE },
      { userId: null, agentId: 'a1', entityContext: { dataSlotsAgent: 'not-a-record' } }
    );

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('filters non-string values from fallbackProviders', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute(
      { structure: VALID_STRUCTURE },
      {
        userId: null,
        agentId: 'a1',
        entityContext: {
          dataSlotsAgent: {
            provider: 'openai',
            model: 'm1',
            fallbackProviders: [42, 'anthropic', null],
          },
        },
      }
    );

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'm1', fallbackProviders: ['anthropic'] },
      'reasoning'
    );
  });

  it('falls back to empty string when provider and model are non-string values', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute(
      { structure: VALID_STRUCTURE },
      {
        userId: null,
        agentId: 'a1',
        entityContext: {
          dataSlotsAgent: { provider: 42, model: null, fallbackProviders: [] },
        },
      }
    );

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('falls back to empty fallbackProviders when the field is not an array', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute(
      { structure: VALID_STRUCTURE },
      {
        userId: null,
        agentId: 'a1',
        entityContext: {
          dataSlotsAgent: { provider: 'openai', model: 'gpt-4o', fallbackProviders: 'not-array' },
        },
      }
    );

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] },
      'reasoning'
    );
  });
});

describe('AppGenerateDataSlotsCapability — error branches', () => {
  it('returns no_provider_configured when resolveAgentProviderAndModel throws', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(result.error?.message).toContain('no provider');
    expect(logger.error).toHaveBeenCalledWith(
      'generate_data_slots: no provider resolved',
      expect.objectContaining({ agentId: 'agent-abc', error: 'no provider' })
    );
  });

  it('returns provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('provider offline'));
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(result.error?.message).toContain('provider offline');
    expect(logger.error).toHaveBeenCalledWith(
      'generate_data_slots: provider unavailable',
      expect.objectContaining({ providerSlug: 'openai' })
    );
  });

  it('classifies an unparseable (likely truncated) schema failure as incomplete_response', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(
      new Error('Data-slot generation response was not valid against the schema after one retry')
    );
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('incomplete_response');
    expect(result.error?.message).toMatch(/cut off|incomplete/i);
    expect(logger.error).toHaveBeenCalledWith(
      'generate_data_slots: structured completion failed',
      expect.objectContaining({ model: 'gpt-4o', provider: 'openai' })
    );
  });

  it('classifies a timed-out completion as generation_timeout', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(
      new Error('Request timed out after 120000ms')
    );
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('generation_timeout');
    expect(result.error?.message).toMatch(/timed out/i);
  });

  it('falls back to generation_failed for an unrecognised error', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('socket hang up'));
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('generation_failed');
    expect(result.error?.message).toContain('socket hang up');
  });

  it('does not call getProvider when resolveAgentProviderAndModel fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('fail'));
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(getProvider).not.toHaveBeenCalled();
  });

  it('does not call runStructuredCompletion when getProvider fails', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('fail'));
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('stringifies non-Error thrown values as the error message', async () => {
    // Exercises the `err instanceof Error ? err.message : String(err)` false branch.
    (resolveAgentProviderAndModel as Mock).mockRejectedValue('plain string error');
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('plain string error');
  });

  it('logs and swallows a rejected logCost promise (fire-and-forget)', async () => {
    (logCost as Mock).mockRejectedValue(new Error('cost log failed'));
    const cap = new AppGenerateDataSlotsCapability();
    const result = await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    // The execute call itself should succeed — logCost is fire-and-forget.
    expect(result.success).toBe(true);
    // Allow the microtask rejection handler to run.
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      'generate_data_slots: logCost rejected',
      expect.objectContaining({ error: 'cost log failed' })
    );
  });
});

describe('classifyGenerationFailure', () => {
  it('maps timeout/abort messages to generation_timeout', () => {
    expect(classifyGenerationFailure('Request timed out', []).code).toBe('generation_timeout');
    expect(classifyGenerationFailure('The operation was aborted', []).code).toBe(
      'generation_timeout'
    );
  });

  it('maps a schema failure with no issue paths to incomplete_response (likely truncation)', () => {
    const r = classifyGenerationFailure('response was not valid against the schema', []);
    expect(r.code).toBe('incomplete_response');
    expect(r.message).toMatch(/cut off|incomplete/i);
  });

  it('maps a schema failure WITH issue paths to invalid_response and names them', () => {
    const r = classifyGenerationFailure('response was not valid against the schema', [
      'slots.0.name',
      'slots.2.theme',
    ]);
    expect(r.code).toBe('invalid_response');
    expect(r.message).toContain('slots.0.name');
    expect(r.message).toContain('slots.2.theme');
  });

  it('falls back to generation_failed for anything else, echoing the raw message', () => {
    const r = classifyGenerationFailure('ECONNRESET', []);
    expect(r.code).toBe('generation_failed');
    expect(r.message).toContain('ECONNRESET');
  });
});

describe('AppGenerateDataSlotsCapability — schema validation (argsSchema)', () => {
  it('requires at least one question in structure', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    // validate() is called by the dispatcher; calling execute() directly bypasses it
    // so we test argsSchema validation through the base class validate() method.
    expect(() => cap.validate({ structure: { questions: [] } })).toThrow();
  });

  it('accepts valid args with optional versionId', () => {
    const cap = new AppGenerateDataSlotsCapability();
    expect(() => cap.validate({ structure: VALID_STRUCTURE, versionId: 'v-1' })).not.toThrow();
  });

  it('accepts valid args without versionId', () => {
    const cap = new AppGenerateDataSlotsCapability();
    expect(() => cap.validate({ structure: VALID_STRUCTURE })).not.toThrow();
  });
});

describe('AppGenerateDataSlotsCapability — parse callback wiring', () => {
  // The parse and onFinalFailure callbacks are passed inline to runStructuredCompletion.
  // We exercise them by capturing the call arguments and invoking the callbacks directly.

  it('parse callback returns the validated output when the JSON is valid', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const parse: (raw: string) => unknown = callOpts?.parse;

    // tryParseJson is also mocked — make it invoke its validator callback with valid data.
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ slots: FAKE_SLOTS })
    );

    const result = parse('{"slots": [...]}');
    expect(result).toEqual({ slots: FAKE_SLOTS });
  });

  it('parse callback returns null and records issue paths when validation fails', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const parse: (raw: string) => unknown = callOpts?.parse;

    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    // Simulate validator being called with invalid data that fails the schema.
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ slots: [{ name: '', description: '', theme: '', questionKeys: [] }] })
    );

    const result = parse('{"slots": [...]}');
    // Zod rejects empty name/description/theme — the parse callback returns null.
    expect(result).toBeNull();
  });

  it('onFinalFailure callback returns an Error with the schema context', async () => {
    const cap = new AppGenerateDataSlotsCapability();
    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    const onFinalFailure: () => Error = callOpts?.onFinalFailure;
    const err = onFinalFailure();

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('not valid against the schema after one retry');
  });

  it('parse callback sets lastIssuePaths so onFinalFailure includes them in the error message', async () => {
    const { tryParseJson } = await import('@/lib/orchestration/evaluations/parse-structured');
    const cap = new AppGenerateDataSlotsCapability();

    // Make tryParseJson invoke the validator with bad data so issue paths get recorded.
    (tryParseJson as Mock).mockImplementation((_raw: string, validate: (p: unknown) => unknown) =>
      validate({ slots: [{ name: '', description: '', theme: '', questionKeys: [] }] })
    );

    await cap.execute({ structure: VALID_STRUCTURE }, BASE_CONTEXT);

    const callOpts = (runStructuredCompletion as Mock).mock.calls[0]?.[0];
    // Execute the parse callback to populate lastIssuePaths.
    const parse: (raw: string) => unknown = callOpts?.parse;
    parse('{"slots": [...]}');

    // Now onFinalFailure should include the issue paths from the parse callback.
    const onFinalFailure: () => Error = callOpts?.onFinalFailure;
    const err = onFinalFailure();
    expect(err.message).toContain('invalid at:');
  });
});
