/**
 * Integration test for the questionnaire extractor capability (F1.1 / PR3).
 *
 * Exercises the capability through the REAL `capabilityDispatcher` and the REAL
 * `runStructuredCompletion` + change-record normaliser, with only the provider
 * (and the DB-backed registry / binding lookups) mocked. This is the seam the
 * plan calls for: "unit-tested by dispatch with a mocked provider; persistence
 * is tested at the route."
 *
 * Covers: happy path, malformed-JSON repair (retry), no-silent-failure on final
 * parse failure, cost logging, admin-supplied inference suppression, and the
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

// Mock cost-tracker (both helpers): `logCost` is called by the capability AND
// the dispatcher; `calculateCost` is used by the REAL runStructuredCompletion.
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
const { AppExtractQuestionnaireStructureCapability } =
  await import('@/lib/app/questionnaire/capabilities/extract-questionnaire-structure');
const { EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG } =
  await import('@/lib/app/questionnaire/constants');
const { CostOperation } = await import('@/types/orchestration');

const SLUG = EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Mock = ReturnType<typeof vi.fn>;

function registryRow() {
  return {
    id: 'cap-1',
    slug: SLUG,
    name: 'Extract Questionnaire Structure',
    category: 'app',
    functionDefinition: {
      name: SLUG,
      description: 'Extract questionnaire structure.',
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

/** A schema-valid extraction payload exercising several change types. */
const VALID_EXTRACTION = {
  sections: [{ ordinal: 0, title: 'Background', description: 'About you' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'full_name',
      prompt: 'What is your full name?',
      suggestedType: 'free_text',
      extractionConfidence: 0.92,
      sourceQuote: 'Name: ____',
    },
  ],
  inferredGoal: 'Collect onboarding details from new hires',
  inferredAudience: { role: 'new hire', expertiseLevel: 'novice' },
  changes: [
    {
      changeType: 'infer_goal',
      targetEntityType: 'version',
      afterJson: 'Collect onboarding details from new hires',
      rationale: 'Derived from the document heading.',
    },
    {
      changeType: 'correct_spelling',
      targetEntityType: 'question',
      beforeJson: 'Naem',
      afterJson: 'Name',
      rationale: 'Fixed typo in the prompt.',
      sourceQuote: 'Naem: ____',
    },
    {
      changeType: 'prune_section',
      targetEntityType: 'section',
      beforeJson: { title: 'For office use only' },
      rationale: 'Administrative boilerplate, not a question.',
      sourceQuote: 'For office use only',
    },
  ],
};

const VALID_JSON = JSON.stringify(VALID_EXTRACTION);

/** A schema-valid payload with NO inferred goal/audience and no changes. */
const MINIMAL_EXTRACTION = {
  sections: [{ ordinal: 0, title: 'Only section' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'q1',
      prompt: 'A single question?',
      suggestedType: 'free_text',
      extractionConfidence: 0.5,
    },
  ],
  changes: [],
};
const MINIMAL_JSON = JSON.stringify(MINIMAL_EXTRACTION);

/** A schema-valid payload carrying a multi-field infer_audience change. */
const AUDIENCE_EXTRACTION = {
  sections: [{ ordinal: 0, title: 'Profile' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'role_q',
      prompt: 'What is your role?',
      suggestedType: 'free_text',
      extractionConfidence: 0.8,
    },
  ],
  inferredAudience: { role: 'manager', expertiseLevel: 'expert' },
  changes: [
    {
      changeType: 'infer_audience',
      targetEntityType: 'version',
      afterJson: { role: 'manager', expertiseLevel: 'expert' },
      rationale: 'Inferred from the document headings.',
    },
  ],
};
const AUDIENCE_JSON = JSON.stringify(AUDIENCE_EXTRACTION);

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    documentText: 'Name: ____\nFor office use only\n',
    fileName: 'onboarding.pdf',
    mediaType: 'application/pdf',
    ...overrides,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    entityContext: { extractorAgent: { provider: '', model: '', fallbackProviders: [] } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  capabilityDispatcher.register(new AppExtractQuestionnaireStructureCapability());
  (prisma.aiCapability.findMany as Mock).mockResolvedValue([registryRow()]);
  (prisma.aiAgentCapability.findMany as Mock).mockResolvedValue([]); // default-allow binding
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('AppExtractQuestionnaireStructureCapability — dispatch', () => {
  it('returns the parsed structure and normalised changes on the happy path', async () => {
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      sections: unknown[];
      questions: unknown[];
      inferredGoal?: string;
      changes: Array<{ changeType: string; afterJson?: unknown }>;
    };
    expect(data.sections).toHaveLength(1);
    expect(data.questions).toHaveLength(1);
    expect(data.inferredGoal).toBe('Collect onboarding details from new hires');
    // Only one provider call on the happy path (no retry).
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // All three changes are coherent → kept; prune's afterJson normalised to null.
    expect(data.changes).toHaveLength(3);
    const prune = data.changes.find((c) => c.changeType === 'prune_section');
    expect(prune?.afterJson).toBeNull();
    expect(data.changes.some((c) => c.changeType === 'infer_goal')).toBe(true);
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

  it('retries when the first response is valid JSON that fails the schema', async () => {
    // Distinct from the non-JSON retry: this parses as JSON but violates the
    // extraction schema (questions must be an array), so it fails the Zod
    // validation arm inside tryParseJson rather than JSON.parse itself.
    const schemaInvalidJson = JSON.stringify({
      sections: [],
      questions: 'not-an-array',
      changes: [],
    });
    const provider = makeProvider([{ content: schemaInvalidJson }, { content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
    // The retried (valid) response is what got parsed — proves recovery, not
    // that the malformed first response slipped through.
    const data = result.data as { sections: unknown[]; questions: unknown[] };
    expect(data.sections).toHaveLength(1);
    expect(data.questions).toHaveLength(1);
  });

  it('surfaces an error (no silent fallback) when both attempts fail to parse', async () => {
    const provider = makeProvider([{ content: 'nope' }, { content: 'still nope' }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('extraction_failed');
    expect(result.data).toBeUndefined();
    expect(provider.chat).toHaveBeenCalledTimes(2);
    // No Zod issue paths (JSON.parse itself failed) ⇒ the message must name the
    // real cause — an unparseable/truncated response — not blame the schema.
    // This is the exact production failure mode for a reasoning model whose
    // output overruns the token cap and comes back as cut-off JSON.
    expect(result.error?.message).toMatch(/not parseable JSON/i);
    expect(result.error?.message).toMatch(/truncat/i);
    expect(result.error?.message).not.toMatch(/not valid against the schema/i);
  });

  it('names the schema fields (not truncation) when the JSON parses but violates the schema on both attempts', async () => {
    // Parses as JSON on both attempts but `questions` is the wrong type — the Zod
    // arm populates issue paths, so the error must cite the invalid field rather
    // than the truncation message. Guards against the two failure modes bleeding
    // into one another.
    const schemaInvalid = JSON.stringify({ sections: [], questions: 'nope', changes: [] });
    const provider = makeProvider([{ content: schemaInvalid }, { content: schemaInvalid }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('extraction_failed');
    expect(result.error?.message).toMatch(/not valid against the schema/i);
    expect(result.error?.message).toMatch(/invalid at:/i);
    expect(result.error?.message).not.toMatch(/truncat/i);
  });

  it('gives the extraction call generous token headroom for reasoning-model output', async () => {
    // Regression guard: 16k truncated real questionnaires mid-JSON on gpt-5.4
    // (reasoning + faithful table/scale output overran the cap). The extraction
    // call must request a budget comfortably above that.
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    const firstCall = provider.chat.mock.calls[0] as unknown as [unknown, { maxTokens?: number }];
    expect(firstCall?.[1]?.maxTokens).toBeGreaterThanOrEqual(32_000);
  });

  it('suppresses infer_goal when the admin supplied the goal', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ adminProvidedGoal: 'Admin-set goal' }),
      baseContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { changes: Array<{ changeType: string }> };
    // The inference change for the admin-owned field is dropped.
    expect(data.changes.some((c) => c.changeType === 'infer_goal')).toBe(false);
    // Other editorial changes survive.
    expect(data.changes.some((c) => c.changeType === 'correct_spelling')).toBe(true);
  });

  it('rejects invalid args (missing documentText) at the dispatcher boundary', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(SLUG, { fileName: 'x.pdf' }, baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_args');
  });

  it('fails closed with no_provider_configured when no provider resolves (no LLM call attempted)', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce(
      new Error('No active LLM provider is configured')
    );
    const provider = makeProvider([{ content: VALID_JSON }]);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    // Bailed before reaching the provider — proves the early return, not a fallback.
    expect(getProvider).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('returns provider_unavailable when the provider cannot be built (after binding resolved)', async () => {
    (getProvider as Mock).mockRejectedValueOnce(new Error('Provider "x" is disabled'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    // It got past binding resolution (step 1) before failing to build the provider.
    expect(resolveAgentProviderAndModel).toHaveBeenCalledTimes(1);
  });

  it('resolves the system-default binding when the context carries no extractor agent', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({ entityContext: undefined })
    );

    expect(result.success).toBe(true);
    // No binding in context → an empty binding is resolved (→ system default).
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
  });

  it('coerces a malformed extractor binding from context to safe types', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      baseContext({
        entityContext: {
          extractorAgent: { provider: 123, model: null, fallbackProviders: ['keep', 7, 'also'] },
        },
      })
    );

    expect(result.success).toBe(true);
    // Non-string provider/model collapse to ''; non-string fallback entries are dropped.
    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: ['keep', 'also'] },
      'reasoning'
    );
  });

  it('omits inferredGoal/inferredAudience when the model inferred neither', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: MINIMAL_JSON }]));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      sections: unknown[];
      inferredGoal?: string;
      inferredAudience?: unknown;
      changes: unknown[];
    };
    // Extraction still produced structure...
    expect(data.sections).toHaveLength(1);
    // ...but the optional inference fields are absent, not null/empty.
    expect(data.inferredGoal).toBeUndefined();
    expect(data.inferredAudience).toBeUndefined();
    expect(data.changes).toHaveLength(0);
  });

  it('suppresses only the admin-owned audience field, keeping the rest of the inference', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: AUDIENCE_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ adminProvidedAudience: { role: 'CEO' } }),
      baseContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { changes: Array<{ changeType: string; afterJson?: unknown }> };
    const audienceChange = data.changes.find((c) => c.changeType === 'infer_audience');
    // The infer_audience change survives but drops the admin-owned `role`,
    // keeping the field the admin did NOT supply.
    expect(audienceChange?.afterJson).toEqual({ expertiseLevel: 'expert' });
  });

  it('still succeeds when cost logging rejects (accounting failure is isolated)', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));
    // The capability's CHAT cost log is the first logCost call — make it reject.
    (logCost as Mock).mockRejectedValueOnce(new Error('cost DB down'));

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    // Extraction is unaffected by the accounting failure...
    expect(result.success).toBe(true);
    // ...and the rejection is caught and logged, not swallowed silently.
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'extract_questionnaire_structure: logCost rejected',
        expect.objectContaining({ error: 'cost DB down' })
      )
    );
  });

  it('surfaces a non-Error rejection as a stringified message', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce('provider exploded');

    const result = await capabilityDispatcher.dispatch(SLUG, baseArgs(), baseContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_provider_configured');
    // errorMessage() stringifies a non-Error throw rather than dropping it.
    expect(result.error?.message).toBe('provider exploded');
  });

  it('handles an upload with no media type', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider([{ content: VALID_JSON }]));

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs({ mediaType: undefined }),
      baseContext()
    );

    expect(result.success).toBe(true);
  });
});

describe('AppExtractQuestionnaireStructureCapability — streaming progress', () => {
  /** A schema-valid payload with THREE questions, to observe a rising count. */
  const MULTI_EXTRACTION = {
    sections: [{ ordinal: 0, title: 'S' }],
    questions: [
      {
        sectionOrdinal: 0,
        key: 'q1',
        prompt: 'First?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
      {
        sectionOrdinal: 0,
        key: 'q2',
        prompt: 'Second?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
      {
        sectionOrdinal: 0,
        key: 'q3',
        prompt: 'Third?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
    ],
    changes: [],
  };
  const MULTI_JSON = JSON.stringify(MULTI_EXTRACTION);

  /** Provider whose `chatStream` yields `content` in fixed-size text chunks + a done chunk. */
  function makeStreamingProvider(
    content: string,
    opts: { chunkSize?: number; retryContent?: string } = {}
  ) {
    const chunkSize = opts.chunkSize ?? 8;
    const chatStream = vi.fn(async function* () {
      for (let i = 0; i < content.length; i += chunkSize) {
        yield { type: 'text', content: content.slice(i, i + chunkSize) };
      }
      yield { type: 'done', usage: { inputTokens: 200, outputTokens: 80 }, finishReason: 'stop' };
    });
    const chat = vi.fn(async () => ({
      content: opts.retryContent ?? '',
      usage: { inputTokens: 50, outputTokens: 20 },
      model: 'test-model',
      finishReason: 'stop' as const,
    }));
    return { chatStream, chat };
  }

  /** Context carrying the live progress sink on `entityContext` (the streaming route's seam). */
  function streamingContext(sink: (n: number) => void) {
    return {
      userId: 'user-1',
      agentId: 'agent-1',
      entityContext: {
        extractorAgent: { provider: '', model: '', fallbackProviders: [] },
        onExtractionProgress: sink,
      },
    };
  }

  it('streams the first attempt and reports a rising question count', async () => {
    const provider = makeStreamingProvider(MULTI_JSON, { chunkSize: 6 });
    (getProvider as Mock).mockResolvedValue(provider);
    const counts: number[] = [];

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      streamingContext((n) => counts.push(n))
    );

    expect(result.success).toBe(true);
    const data = result.data as { questions: unknown[] };
    expect(data.questions).toHaveLength(3);
    // Streamed, not blocking: chatStream drove the first attempt; chat never ran.
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(provider.chat).not.toHaveBeenCalled();
    // The sink saw each question close exactly once, strictly increasing to 3.
    expect(counts).toEqual([1, 2, 3]);
  });

  it('reports each count once even when the JSON arrives one character at a time', async () => {
    const provider = makeStreamingProvider(MULTI_JSON, { chunkSize: 1 });
    (getProvider as Mock).mockResolvedValue(provider);
    const counts: number[] = [];

    await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      streamingContext((n) => counts.push(n))
    );

    expect(counts).toEqual([1, 2, 3]);
  });

  it('logs cost from the streamed done-chunk usage', async () => {
    const provider = makeStreamingProvider(MULTI_JSON, { chunkSize: 6 });
    (getProvider as Mock).mockResolvedValue(provider);

    await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      streamingContext(() => {})
    );

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: CostOperation.CHAT,
        inputTokens: 200,
        outputTokens: 80,
      })
    );
  });

  it('falls back to a non-streaming temp-0 retry when the streamed JSON is malformed', async () => {
    const provider = makeStreamingProvider('not json at all', { retryContent: MULTI_JSON });
    (getProvider as Mock).mockResolvedValue(provider);
    const counts: number[] = [];

    const result = await capabilityDispatcher.dispatch(
      SLUG,
      baseArgs(),
      streamingContext((n) => counts.push(n))
    );

    expect(result.success).toBe(true);
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    // The malformed stream produced no complete questions → nothing to report.
    expect(counts).toEqual([]);
  });
});

describe('AppExtractQuestionnaireStructureCapability — redactProvenance', () => {
  const capability = new AppExtractQuestionnaireStructureCapability();

  it('redacts document text and emits a PII-safe, capped success preview', () => {
    const args = baseArgs({ adminProvidedGoal: 'secret goal' }) as Parameters<
      typeof capability.redactProvenance
    >[0];
    const redaction = capability.redactProvenance(args, {
      success: true,
      data: {
        sections: [{ ordinal: 0, title: 'Background' }],
        questions: [
          {
            sectionOrdinal: 0,
            key: 'q',
            prompt: 'Sensitive prompt with a name',
            suggestedType: 'free_text',
            extractionConfidence: 1,
          },
        ],
        changes: [],
      },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs.fileName).toBe('onboarding.pdf');
    expect(String(safeArgs.documentText)).toContain('redacted');
    expect(String(safeArgs.adminProvidedGoal)).toContain('redacted');
    // Preview leaks no document text — counts only — and stays capped.
    expect(redaction.resultPreview).not.toContain('Sensitive prompt');
    expect(redaction.resultPreview).toContain('questionCount');
    expect(redaction.resultPreview.length).toBeLessThanOrEqual(200);
  });

  it('passes an error envelope through the preview untouched', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'extraction_failed', message: 'boom' },
    });
    expect(redaction.resultPreview).toContain('extraction_failed');
  });

  it('redacts admin-provided audience in the persisted args', () => {
    const args = baseArgs({
      adminProvidedAudience: { role: 'CFO', sensitivity: 'high' },
    }) as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: { sections: [], questions: [], changes: [] },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    // The audience object can carry PII-adjacent detail — replaced with a sentinel.
    expect(String(safeArgs.adminProvidedAudience)).toContain('redacted');
    expect(safeArgs.adminProvidedAudience).not.toEqual({ role: 'CFO', sensitivity: 'high' });
  });

  it('caps an over-long error preview at 200 chars with an ellipsis', () => {
    const args = baseArgs() as Parameters<typeof capability.redactProvenance>[0];
    const redaction = capability.redactProvenance(args, {
      success: false,
      error: { code: 'extraction_failed', message: 'x'.repeat(500) },
    });

    expect(redaction.resultPreview.length).toBe(200);
    expect(redaction.resultPreview.endsWith('…')).toBe(true);
  });

  it('omits absent optional args and flags present inference in the preview', () => {
    // No mediaType, no admin fields → those keys should be absent from safeArgs.
    const args = {
      documentText: 'some text',
      fileName: 'plain.txt',
    } as Parameters<typeof capability.redactProvenance>[0];

    const redaction = capability.redactProvenance(args, {
      success: true,
      data: {
        sections: [{ ordinal: 0, title: 'S' }],
        questions: [],
        inferredGoal: 'a goal',
        inferredAudience: { role: 'analyst' },
        changes: [],
      },
    });

    const safeArgs = redaction.args as Record<string, unknown>;
    expect(safeArgs).not.toHaveProperty('mediaType');
    expect(safeArgs).not.toHaveProperty('adminProvidedGoal');
    expect(safeArgs).not.toHaveProperty('adminProvidedAudience');
    // Preview reports the inference flags as true when the model inferred them.
    const preview = JSON.parse(redaction.resultPreview) as {
      data: { hasInferredGoal: boolean; hasInferredAudience: boolean };
    };
    expect(preview.data.hasInferredGoal).toBe(true);
    expect(preview.data.hasInferredAudience).toBe(true);
  });
});
