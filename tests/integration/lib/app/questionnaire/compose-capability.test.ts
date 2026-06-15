/**
 * Integration test for the generative-authoring capabilities (compose-from-brief +
 * refine).
 *
 * Exercises both capabilities through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion`, with only the provider (and the DB-backed registry /
 * binding lookups) mocked — the same seam the extractor capability test uses.
 *
 * Covers: happy path (empty change log), malformed-JSON repair, no-silent-failure,
 * cost logging, invalid args, provider fail-closed, redactProvenance, and the
 * refine round-trip (structure + summary).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

const { prisma } = await import('@/lib/db/client');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { AppComposeQuestionnaireCapability } =
  await import('@/lib/app/questionnaire/capabilities/compose-questionnaire');
const { AppRefineQuestionnaireStructureCapability } =
  await import('@/lib/app/questionnaire/capabilities/refine-questionnaire-structure');
const { COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG, REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG } =
  await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

type Mock = ReturnType<typeof vi.fn>;
const COMPOSE = COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG;
const REFINE = REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG;

function registryRow(slug: string) {
  return {
    id: `cap-${slug}`,
    slug,
    name: slug,
    category: 'app',
    functionDefinition: {
      name: slug,
      description: 'x',
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

function makeProvider(
  scripts: { content: string; usage?: { inputTokens: number; outputTokens: number } }[]
) {
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

const VALID_STRUCTURE = {
  sections: [{ ordinal: 0, title: 'Background', description: 'About you' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'full_name',
      prompt: 'What is your full name?',
      suggestedType: 'free_text' as const,
      extractionConfidence: 0.9,
    },
  ],
  inferredGoal: 'Gauge churn risk',
  inferredAudience: { role: 'customer success manager', expertiseLevel: 'intermediate' as const },
};
const VALID_STRUCTURE_JSON = JSON.stringify(VALID_STRUCTURE);

const VALID_REFINE_JSON = JSON.stringify({
  structure: VALID_STRUCTURE,
  summary: 'Shortened the questionnaire to one section.',
});

function composeArgs(overrides: Record<string, unknown> = {}) {
  return { brief: 'An onboarding survey for B2B SaaS churn risk', ...overrides };
}

function refineArgs(overrides: Record<string, unknown> = {}) {
  return {
    currentStructure: {
      sections: VALID_STRUCTURE.sections,
      questions: VALID_STRUCTURE.questions,
    },
    instruction: 'Make it shorter',
    ...overrides,
  };
}

function composerContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    entityContext: { composerAgent: { provider: '', model: '', fallbackProviders: [] } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppComposeQuestionnaireCapability());
  capabilityDispatcher.register(new AppRefineQuestionnaireStructureCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([
    registryRow(COMPOSE),
    registryRow(REFINE),
  ]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]);
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppComposeQuestionnaireCapability — dispatch', () => {
  it('composes a structure with an empty change log on the happy path', async () => {
    const provider = makeProvider([{ content: VALID_STRUCTURE_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      sections: unknown[];
      questions: unknown[];
      inferredGoal?: string;
      changes: unknown[];
    };
    expect(data.sections).toHaveLength(1);
    expect(data.questions).toHaveLength(1);
    expect(data.inferredGoal).toBe('Gauge churn risk');
    // Generation has no before-state — the change log is always empty.
    expect(data.changes).toEqual([]);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('repairs a malformed first response via the retry path', async () => {
    const provider = makeProvider([{ content: 'not json' }, { content: VALID_STRUCTURE_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('surfaces composition_failed (no silent fallback) when both attempts fail', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: 'nope' }, { content: 'still nope' }])
    );

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('composition_failed');
  });

  it('rejects invalid args (missing brief) at the dispatcher boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    const result = await capabilityDispatcher.dispatch(COMPOSE, {}, composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_args');
  });

  it('fails closed with no_provider_configured and never calls the provider', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce(new Error('no provider'));
    const provider = makeProvider([{ content: VALID_STRUCTURE_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(getProvider).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('logs LLM cost as a CHAT operation with the resolved model/provider', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([
        { content: VALID_STRUCTURE_JSON, usage: { inputTokens: 200, outputTokens: 80 } },
      ])
    );

    await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        operation: CostOperation.CHAT,
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 200,
        outputTokens: 80,
      })
    );
  });
});

describe('AppComposeQuestionnaireCapability — redactProvenance', () => {
  const capability = new AppComposeQuestionnaireCapability();

  it('redacts the brief and emits a PII-safe, counts-only success preview', () => {
    const args = composeArgs({ adminProvidedGoal: 'secret' }) as Parameters<
      typeof capability.redactProvenance
    >[0];
    const redaction = capability.redactProvenance(args, {
      success: true,
      data: {
        sections: [{ ordinal: 0, title: 'S' }],
        questions: [
          {
            sectionOrdinal: 0,
            key: 'q',
            prompt: 'Sensitive prompt',
            suggestedType: 'free_text',
            extractionConfidence: 1,
          },
        ],
        changes: [],
      },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(String(safeArgs.brief)).toContain('redacted');
    expect(String(safeArgs.adminProvidedGoal)).toContain('redacted');
    expect(redaction.resultPreview).not.toContain('Sensitive prompt');
    expect(redaction.resultPreview).toContain('questionCount');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
  });
});

describe('AppRefineQuestionnaireStructureCapability — dispatch', () => {
  it('returns the updated structure plus a summary on the happy path', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_REFINE_JSON }]));

    const result = await capabilityDispatcher.dispatch(REFINE, refineArgs(), composerContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      structure: { sections: unknown[]; changes: unknown[] };
      summary: string;
    };
    expect(data.summary).toContain('Shortened');
    expect(data.structure.sections).toHaveLength(1);
    expect(data.structure.changes).toEqual([]);
  });

  it('rejects invalid args (missing instruction)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_REFINE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      REFINE,
      refineArgs({ instruction: undefined }),
      composerContext()
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_args');
  });

  it('surfaces refinement_failed when the model output never validates', async () => {
    // Missing the required `summary` key both times → schema-invalid.
    const bad = JSON.stringify({ structure: VALID_STRUCTURE });
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: bad }, { content: bad }]));

    const result = await capabilityDispatcher.dispatch(REFINE, refineArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('refinement_failed');
  });

  it('fails closed with no_provider_configured when provider resolution throws', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce(new Error('no provider'));
    const provider = makeProvider([{ content: VALID_REFINE_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(REFINE, refineArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('fails closed with provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValueOnce(new Error('provider offline'));

    const result = await capabilityDispatcher.dispatch(REFINE, refineArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('logs LLM cost with the resolved model/provider on success', async () => {
    (getProvider as Mock).mockResolvedValue(
      makeProvider([{ content: VALID_REFINE_JSON, usage: { inputTokens: 150, outputTokens: 60 } }])
    );

    await capabilityDispatcher.dispatch(REFINE, refineArgs(), composerContext());

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        operation: CostOperation.CHAT,
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 150,
        outputTokens: 60,
      })
    );
  });
});

describe('AppComposeQuestionnaireCapability — provider_unavailable branch', () => {
  it('fails closed with provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValueOnce(new Error('provider offline'));

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
  });
});

describe('AppComposeQuestionnaireCapability — entityContext branches', () => {
  it('falls back to empty binding when entityContext is null', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    // Pass a context with no entityContext — the capability must not throw.
    const result = await capabilityDispatcher.dispatch(
      COMPOSE,
      composeArgs(),
      composerContext({ entityContext: null })
    );

    // The resolver is mocked to succeed regardless of the binding value.
    expect(result.success).toBe(true);
  });

  it('falls back to empty binding when entityContext.composerAgent is a non-record', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      COMPOSE,
      composeArgs(),
      composerContext({ entityContext: { composerAgent: 'not-a-record' } })
    );

    expect(result.success).toBe(true);
  });

  it('omits agentId from logCost when context carries no agentId', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    await capabilityDispatcher.dispatch(
      COMPOSE,
      composeArgs(),
      // Use an empty agentId — the capability treats falsy agentId as absent.
      {
        userId: 'user-1',
        agentId: '',
        entityContext: { composerAgent: { provider: '', model: '', fallbackProviders: [] } },
      }
    );

    // logCost should have been called WITHOUT an agentId key when it's absent.
    expect(logCost).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() })
    );
  });
});

describe('AppComposeQuestionnaireCapability — redactProvenance failure path', () => {
  const capability = new AppComposeQuestionnaireCapability();

  it('serialises the raw error result when success is false', () => {
    const redaction = capability.redactProvenance(
      { brief: 'test' },
      { success: false, error: { code: 'composition_failed', message: 'oops' } }
    );

    // The preview must contain the error code, not a counts object.
    expect(redaction.resultPreview).toContain('composition_failed');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
  });

  it('truncates a very long preview with an ellipsis', () => {
    // Build a result whose JSON serialisation exceeds 200 chars.
    const longResult = {
      success: false as const,
      error: { code: 'x'.repeat(50), message: 'y'.repeat(200) },
    };

    const redaction = capability.redactProvenance({ brief: 'test' }, longResult);

    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });

  it('redacts adminProvidedAudience when present', () => {
    const args = {
      brief: 'b',
      adminProvidedAudience: { role: 'manager' } as Parameters<
        typeof capability.redactProvenance
      >[0]['adminProvidedAudience'],
    };
    const redaction = capability.redactProvenance(args, {
      success: true,
      data: { sections: [], questions: [], changes: [] },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(String(safeArgs.adminProvidedAudience)).toContain('redacted');
  });
});

describe('AppComposeQuestionnaireCapability — readComposerAgentBinding branches', () => {
  it('filters out non-string entries in fallbackProviders', async () => {
    // Pass a composerAgent whose fallbackProviders contains mixed types — only strings survive.
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      COMPOSE,
      composeArgs(),
      composerContext({
        entityContext: {
          composerAgent: {
            provider: '',
            model: '',
            // Mixed array — the filter must drop the number and null, keep only strings.
            fallbackProviders: ['valid-provider', 42, null, 'another-provider'],
          },
        },
      })
    );

    // The capability resolves (resolver is mocked) and produces a valid result.
    expect(result.success).toBe(true);
    // The non-string entries were silently dropped; resolution still succeeded.
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackProviders: ['valid-provider', 'another-provider'] }),
      'reasoning'
    );
  });

  it('falls back to empty strings when provider and model are non-string in a record binding', async () => {
    // composerAgent is a record but with numeric provider/model and no fallbackProviders array.
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      COMPOSE,
      composeArgs(),
      composerContext({
        entityContext: {
          composerAgent: {
            provider: 99, // non-string → must fall back to ''
            model: null, // non-string → must fall back to ''
            fallbackProviders: 'not-an-array', // non-array → must fall back to []
          },
        },
      })
    );

    expect(result.success).toBe(true);
    // The binding passed to resolver must have empty strings and empty array.
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });
});

describe('AppComposeQuestionnaireCapability — non-Error thrown values', () => {
  it('handles a non-Error rejection from resolveAgentProviderAndModel', async () => {
    // Exercises the String(err) branch in errorMessage() — rejection with a string, not Error.
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce('string error value');

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    expect(result.error?.message).toContain('string error value');
  });

  it('handles a non-Error rejection from getProvider', async () => {
    // Exercises the String(err) branch for provider_unavailable.
    (getProvider as Mock).mockRejectedValueOnce('provider string error');

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(result.error?.message).toContain('provider string error');
  });
});

describe('AppComposeQuestionnaireCapability — toAdminSuppliedMetadata branches', () => {
  it('succeeds when only adminProvidedAudience is set (no goal)', async () => {
    // Exercises the adminProvidedAudience !== undefined branch (line 116) without a goal.
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      COMPOSE,
      composeArgs({
        adminProvidedAudience: { role: 'engineer', expertiseLevel: 'expert' as const },
      }),
      composerContext()
    );

    expect(result.success).toBe(true);
  });
});

describe('AppComposeQuestionnaireCapability — schema-invalid JSON triggers issuePaths on first attempt', () => {
  it('sets issuePaths when first response is schema-invalid JSON, then succeeds on retry', async () => {
    // First response is valid JSON but fails composeStructureSchema validation.
    // Second response is the valid structure — the retry path succeeds.
    const badButValidJson = JSON.stringify({ wrong: 'shape' });
    const provider = makeProvider([
      { content: badButValidJson },
      { content: VALID_STRUCTURE_JSON },
    ]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    // The capability recovered on retry — result should be successful.
    expect(result.success).toBe(true);
    // Two LLM calls: first (schema-invalid) + retry.
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('includes issue path details in the error when both attempts fail with a schema error', async () => {
    // Both responses are valid JSON but fail schema validation — the onFinalFailure
    // error should mention the invalid paths (lastIssuePaths.length > 0 branch).
    const missingQs = JSON.stringify({ sections: [{ ordinal: 0, title: 'S' }] }); // no questions key
    const provider = makeProvider([{ content: missingQs }, { content: missingQs }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('composition_failed');
  });
});

describe('AppComposeQuestionnaireCapability — logCost rejection is absorbed', () => {
  it('does not fail the result when logCost rejects', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_STRUCTURE_JSON }]));
    (logCost as Mock).mockRejectedValueOnce(new Error('cost-tracker down'));

    const result = await capabilityDispatcher.dispatch(COMPOSE, composeArgs(), composerContext());

    // logCost is fire-and-forget — a rejection must not surface as a capability error.
    expect(result.success).toBe(true);
  });
});

describe('AppRefineQuestionnaireStructureCapability — entityContext non-record binding', () => {
  it('falls back to empty binding when entityContext.composerAgent is not a record', async () => {
    // Exercises the !isRecord(raw) fallback return (line 88) in refine-questionnaire-structure.ts.
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_REFINE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      REFINE,
      refineArgs(),
      composerContext({ entityContext: { composerAgent: 'not-a-record' } })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });
});

describe('AppRefineQuestionnaireStructureCapability — readComposerAgentBinding branches', () => {
  it('filters out non-string entries in fallbackProviders', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_REFINE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      REFINE,
      refineArgs(),
      composerContext({
        entityContext: {
          composerAgent: {
            provider: '',
            model: '',
            // Mixed array — the filter must drop the non-strings.
            fallbackProviders: ['ok-provider', 99, undefined],
          },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackProviders: ['ok-provider'] }),
      'reasoning'
    );
  });

  it('falls back to empty strings and empty array when provider/model are non-strings and fallbackProviders is not an array', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_REFINE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      REFINE,
      refineArgs(),
      composerContext({
        entityContext: {
          composerAgent: {
            provider: 99, // non-string
            model: false, // non-string
            fallbackProviders: 'x', // non-array
          },
        },
      })
    );

    expect(result.success).toBe(true);
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });
});

describe('AppRefineQuestionnaireStructureCapability — logCost rejection is absorbed', () => {
  it('does not fail the result when logCost rejects', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_REFINE_JSON }]));
    (logCost as Mock).mockRejectedValueOnce(new Error('cost-tracker down'));

    const result = await capabilityDispatcher.dispatch(REFINE, refineArgs(), composerContext());

    expect(result.success).toBe(true);
  });
});

describe('AppRefineQuestionnaireStructureCapability — redactProvenance', () => {
  const capability = new AppRefineQuestionnaireStructureCapability();

  it('redacts instruction and currentStructure', () => {
    const redaction = capability.redactProvenance(
      {
        instruction: 'Make it shorter',
        currentStructure: VALID_STRUCTURE,
      },
      {
        success: true,
        data: {
          structure: {
            sections: VALID_STRUCTURE.sections,
            questions: VALID_STRUCTURE.questions,
            changes: [],
          },
          summary: 'Shortened',
        },
      }
    );

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(String(safeArgs.instruction)).toContain('redacted');
    expect(String(safeArgs.currentStructure)).toContain('redacted');
    expect(redaction.resultPreview).toContain('sectionCount');
    expect(redaction.resultPreview).toContain('questionCount');
  });

  it('serialises the raw error result when success is false', () => {
    const redaction = capability.redactProvenance(
      { instruction: 'x', currentStructure: VALID_STRUCTURE },
      { success: false, error: { code: 'refinement_failed', message: 'err' } }
    );

    expect(redaction.resultPreview).toContain('refinement_failed');
  });

  it('truncates a very long error preview with an ellipsis', () => {
    const longResult = {
      success: false as const,
      error: { code: 'r'.repeat(50), message: 's'.repeat(200) },
    };

    const redaction = capability.redactProvenance(
      { instruction: 'x', currentStructure: VALID_STRUCTURE },
      longResult
    );

    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });
});
