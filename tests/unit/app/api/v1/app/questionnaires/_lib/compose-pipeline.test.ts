/**
 * Unit tests for the generative-authoring compose pipeline helpers.
 *
 * File under test: app/api/v1/app/questionnaires/_lib/compose-pipeline.ts
 *
 * Covers:
 *   - loadComposerAgent: returns the agent binding or a 503 response when missing
 *   - composeFromBrief: happy path, dispatch errors (status mapping), incoherence
 *   - loadRefinableStructure: 404 (not found / wrong questionnaire), no status/session
 *     block (the route forks a draft instead), happy path projection
 *   - ComposeAdminMeta (type-level — exercised through composeFromBrief call)
 *
 * All collaborators are mocked. Tests assert what the helpers DO — they return
 * discriminated-union shapes, call the dispatcher with specific arguments, and map
 * error codes to HTTP statuses — not just what mocks return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist prisma mock so vi.mock() closure can reference it ─────────────────

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findUnique: vi.fn() },
  appQuestionnaireVersion: { findUnique: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  registerBuiltInCapabilities: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/persist', () => ({
  assertPersistable: vi.fn(),
  IncoherentExtractionError: class IncoherentExtractionError extends Error {
    orphanSectionOrdinals: number[];
    constructor(ordinals: number[]) {
      super('Extraction is incoherent');
      this.name = 'IncoherentExtractionError';
      this.orphanSectionOrdinals = ordinals;
    }
  },
}));

// ─── Deferred imports (after mocks) ──────────────────────────────────────────

import {
  loadComposerAgent,
  composeFromBrief,
  loadRefinableStructure,
  type ComposerAgent,
} from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  assertPersistable,
  IncoherentExtractionError,
} from '@/app/api/v1/app/questionnaires/_lib/persist';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const AGENT_ROW = {
  id: 'agent-1',
  provider: 'anthropic',
  model: 'claude-opus',
  fallbackProviders: ['openai'],
};

/** Minimal valid ExtractQuestionnaireStructureData the dispatcher would return. */
const DISPATCH_EXTRACTION = {
  sections: [{ ordinal: 0, title: 'General' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'q1',
      prompt: 'What is your name?',
      suggestedType: 'free_text' as const,
      extractionConfidence: 1,
    },
  ],
  changes: [] as never[],
};

/** Stub logger — the helpers accept a route logger but only call warn/error on it. */
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Awaited<ReturnType<typeof import('@/lib/api/context').getRouteLogger>>;

/** A minimal DB version row that represents a refinable draft. */
function makeDraftVersion(overrides: Record<string, unknown> = {}) {
  return {
    questionnaireId: 'qn-1',
    status: 'draft',
    goal: null,
    audience: null,
    _count: { sessions: 0 },
    sections: [
      {
        ordinal: 0,
        title: 'General',
        description: null,
        questions: [
          {
            key: 'q1',
            prompt: 'What is your role?',
            type: 'free_text',
            typeConfig: null,
            guidelines: null,
            rationale: null,
            extractionConfidence: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: agent exists
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  // Default: dispatch succeeds
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: DISPATCH_EXTRACTION,
  });
  // Default: assertPersistable passes
  (assertPersistable as Mock).mockImplementation(() => undefined);
  // Default: draft version exists
  prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(makeDraftVersion());
});

// ═════════════════════════════════════════════════════════════════════════════
// loadComposerAgent
// ═════════════════════════════════════════════════════════════════════════════

describe('loadComposerAgent', () => {
  it('returns ok:true with the agent binding when the agent row exists', async () => {
    const result = await loadComposerAgent(fakeLogger);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('narrowing');
    // The returned value exposes the fields the routes need
    expect(result.value.id).toBe('agent-1');
    expect(result.value.provider).toBe('anthropic');
    expect(result.value.model).toBe('claude-opus');
    expect(result.value.fallbackProviders).toEqual(['openai']);
  });

  it('queries with the canonical composer agent slug', async () => {
    await loadComposerAgent(fakeLogger);

    expect(prismaMock.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'app-questionnaire-composer' },
      })
    );
  });

  it('selects only the fields the routes need (no unnecessary data)', async () => {
    await loadComposerAgent(fakeLogger);

    const call = prismaMock.aiAgent.findUnique.mock.calls[0][0] as {
      select: Record<string, boolean>;
    };
    expect(call.select).toMatchObject({
      id: true,
      provider: true,
      model: true,
      fallbackProviders: true,
    });
  });

  it('returns ok:false with a 503 response when agent is not seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);

    const result = await loadComposerAgent(fakeLogger);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('narrowing');
    expect(result.response.status).toBe(503);

    const body = (await result.response.json()) as { success: boolean; error: { code: string } };
    expect(body.error.code).toBe('COMPOSER_NOT_CONFIGURED');
  });

  it('logs an error when the agent is missing', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);

    await loadComposerAgent(fakeLogger);

    expect(fakeLogger.error).toHaveBeenCalledOnce();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// composeFromBrief
// ═════════════════════════════════════════════════════════════════════════════

describe('composeFromBrief', () => {
  const agent: ComposerAgent = AGENT_ROW;

  it('returns ok:true with the extraction when dispatch succeeds and structure is coherent', async () => {
    const result = await composeFromBrief(
      agent,
      { brief: 'Build a survey', adminMeta: {}, adminId: 'admin-1' },
      fakeLogger
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('narrowing');
    expect(result.value.sections).toHaveLength(1);
    expect(result.value.questions).toHaveLength(1);
  });

  it('calls registerBuiltInCapabilities before dispatching', async () => {
    await composeFromBrief(
      agent,
      { brief: 'Staff survey', adminMeta: {}, adminId: 'admin-1' },
      fakeLogger
    );

    expect(registerBuiltInCapabilities).toHaveBeenCalledOnce();
  });

  it('dispatches with the compose capability slug and the agent entity context', async () => {
    await composeFromBrief(
      agent,
      { brief: 'Health survey', adminMeta: {}, adminId: 'admin-42' },
      fakeLogger
    );

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'app_compose_questionnaire',
      expect.objectContaining({ brief: 'Health survey' }),
      expect.objectContaining({
        userId: 'admin-42',
        agentId: 'agent-1',
        entityContext: expect.objectContaining({
          composerAgent: {
            provider: 'anthropic',
            model: 'claude-opus',
            fallbackProviders: ['openai'],
          },
        }),
      })
    );
  });

  it('forwards adminProvidedGoal in dispatch args when adminMeta.goal is set', async () => {
    await composeFromBrief(
      agent,
      { brief: 'Brief', adminMeta: { goal: 'Collect safety data' }, adminId: 'admin-1' },
      fakeLogger
    );

    const [, dispatchArgs] = (capabilityDispatcher.dispatch as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(dispatchArgs).toHaveProperty('adminProvidedGoal', 'Collect safety data');
  });

  it('omits adminProvidedGoal from dispatch args when adminMeta.goal is not set', async () => {
    await composeFromBrief(
      agent,
      { brief: 'Brief', adminMeta: {}, adminId: 'admin-1' },
      fakeLogger
    );

    const [, dispatchArgs] = (capabilityDispatcher.dispatch as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(dispatchArgs).not.toHaveProperty('adminProvidedGoal');
  });

  it('forwards adminProvidedAudience in dispatch args when adminMeta.audience is set', async () => {
    await composeFromBrief(
      agent,
      {
        brief: 'Brief',
        adminMeta: { audience: { role: 'clinician' } },
        adminId: 'admin-1',
      },
      fakeLogger
    );

    const [, dispatchArgs] = (capabilityDispatcher.dispatch as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(dispatchArgs).toHaveProperty('adminProvidedAudience', { role: 'clinician' });
  });

  describe('dispatch error → status mapping', () => {
    const errorCases = [
      { code: 'rate_limited', expectedStatus: 429, expectedCode: 'COMPOSER_RATE_LIMITED' },
      { code: 'invalid_args', expectedStatus: 400, expectedCode: 'INVALID_COMPOSE_ARGS' },
      { code: 'no_provider_configured', expectedStatus: 503, expectedCode: 'COMPOSER_UNAVAILABLE' },
      { code: 'provider_unavailable', expectedStatus: 503, expectedCode: 'COMPOSER_UNAVAILABLE' },
      { code: 'capability_inactive', expectedStatus: 503, expectedCode: 'COMPOSER_UNAVAILABLE' },
      {
        code: 'capability_disabled_for_agent',
        expectedStatus: 503,
        expectedCode: 'COMPOSER_UNAVAILABLE',
      },
      { code: 'unknown_capability', expectedStatus: 503, expectedCode: 'COMPOSER_UNAVAILABLE' },
      { code: 'capability_quarantined', expectedStatus: 503, expectedCode: 'COMPOSER_UNAVAILABLE' },
      { code: 'requires_approval', expectedStatus: 503, expectedCode: 'COMPOSER_UNAVAILABLE' },
      { code: 'unexpected_error', expectedStatus: 502, expectedCode: 'COMPOSITION_FAILED' },
    ];

    for (const { code, expectedStatus, expectedCode } of errorCases) {
      it(`maps dispatch error '${code}' → ${expectedStatus} ${expectedCode}`, async () => {
        (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
          success: false,
          error: { code, message: `Error: ${code}` },
        });

        const result = await composeFromBrief(
          agent,
          { brief: 'Brief', adminMeta: {}, adminId: 'admin-1' },
          fakeLogger
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('narrowing');
        expect(result.response.status).toBe(expectedStatus);

        const body = (await result.response.json()) as {
          success: boolean;
          error: { code: string };
        };
        expect(body.error.code).toBe(expectedCode);
      });
    }

    it('returns ok:false when dispatch.data is null even if success is true', async () => {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: true,
        data: null,
      });

      const result = await composeFromBrief(
        agent,
        { brief: 'Brief', adminMeta: {}, adminId: 'admin-1' },
        fakeLogger
      );

      expect(result.ok).toBe(false);
    });

    it('includes the capability error code in error details', async () => {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: false,
        error: { code: 'provider_unavailable', message: 'No provider' },
      });

      const result = await composeFromBrief(
        agent,
        { brief: 'Brief', adminMeta: {}, adminId: 'admin-1' },
        fakeLogger
      );
      if (result.ok) throw new Error('narrowing');

      const body = (await result.response.json()) as {
        error: { details?: { capabilityError: string } };
      };
      expect(body.error.details?.capabilityError).toBe('provider_unavailable');
    });
  });

  describe('incoherence check', () => {
    it('returns ok:false with 422 COMPOSITION_INCOHERENT when assertPersistable throws', async () => {
      (assertPersistable as Mock).mockImplementation(() => {
        throw new IncoherentExtractionError([3, 7]);
      });

      const result = await composeFromBrief(
        agent,
        { brief: 'Brief', adminMeta: {}, adminId: 'admin-1' },
        fakeLogger
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('narrowing');
      expect(result.response.status).toBe(422);

      const body = (await result.response.json()) as {
        error: { code: string; details: { orphanSectionOrdinals: number[] } };
      };
      expect(body.error.code).toBe('COMPOSITION_INCOHERENT');
      expect(body.error.details.orphanSectionOrdinals).toEqual([3, 7]);
    });

    it('rethrows non-IncoherentExtractionError exceptions from assertPersistable', async () => {
      (assertPersistable as Mock).mockImplementation(() => {
        throw new TypeError('Unexpected type error');
      });

      await expect(
        composeFromBrief(agent, { brief: 'Brief', adminMeta: {}, adminId: 'admin-1' }, fakeLogger)
      ).rejects.toThrow(TypeError);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// loadRefinableStructure
// ═════════════════════════════════════════════════════════════════════════════

describe('loadRefinableStructure', () => {
  it('returns ok:false with 404 NOT_FOUND when version does not exist', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(null);

    const result = await loadRefinableStructure('qn-1', 'ver-missing');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('narrowing');
    expect(result.response.status).toBe(404);

    const body = (await result.response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns ok:false with 404 NOT_FOUND when versionId belongs to a different questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      makeDraftVersion({ questionnaireId: 'qn-other' })
    );

    const result = await loadRefinableStructure('qn-1', 'ver-1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('narrowing');
    expect(result.response.status).toBe(404);
  });

  it('does NOT block a launched version — the refine route forks a draft instead', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      makeDraftVersion({ status: 'launched' })
    );

    const result = await loadRefinableStructure('qn-1', 'ver-1');

    // Status/session gating moved to the route's fork step; the loader only reads the structure.
    expect(result.ok).toBe(true);
  });

  it('does NOT block a version with respondent sessions — the route forks a draft instead', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      makeDraftVersion({ status: 'launched', _count: { sessions: 3 } })
    );

    const result = await loadRefinableStructure('qn-1', 'ver-1');

    expect(result.ok).toBe(true);
  });

  it('queries with the versionId and selects necessary fields for structure assembly', async () => {
    await loadRefinableStructure('qn-1', 'ver-1');

    const call = prismaMock.appQuestionnaireVersion.findUnique.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'ver-1' });
    expect(call.select).toMatchObject({
      questionnaireId: true,
      goal: true,
      audience: true,
    });
    expect(call.select.sections).toBeDefined();
    // The status / session-count gating fields are no longer read (the route forks instead).
    expect(call.select).not.toHaveProperty('status');
    expect(call.select).not.toHaveProperty('_count');
  });

  describe('happy path — structure projection', () => {
    it('returns ok:true with the draft structure projected as ComposeStructure', async () => {
      const result = await loadRefinableStructure('qn-1', 'ver-1');

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('narrowing');

      const { value } = result;
      expect(value.sections).toHaveLength(1);
      expect(value.sections[0]).toMatchObject({ ordinal: 0, title: 'General' });
      expect(value.questions).toHaveLength(1);
      expect(value.questions[0]).toMatchObject({
        sectionOrdinal: 0,
        key: 'q1',
        prompt: 'What is your role?',
        suggestedType: 'free_text',
      });
    });

    it('includes description in section when present on the DB row', async () => {
      prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
        makeDraftVersion({
          sections: [
            {
              ordinal: 0,
              title: 'Background',
              description: 'Tell us about yourself',
              questions: [],
            },
          ],
        })
      );

      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value.sections[0]).toMatchObject({
        description: 'Tell us about yourself',
      });
    });

    it('omits description from section when it is null', async () => {
      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      // The default makeDraftVersion has description: null — it should be omitted
      expect(result.value.sections[0]).not.toHaveProperty('description');
    });

    it('uses extractionConfidence 1 as the neutral default when DB value is null', async () => {
      // makeDraftVersion sets extractionConfidence: null on the question
      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value.questions[0].extractionConfidence).toBe(1);
    });

    it('includes inferredGoal when version.goal is not null', async () => {
      prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
        makeDraftVersion({ goal: 'Assess onboarding friction' })
      );

      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value.inferredGoal).toBe('Assess onboarding friction');
    });

    it('omits inferredGoal when version.goal is null', async () => {
      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value).not.toHaveProperty('inferredGoal');
    });

    it('includes inferredAudience when version.audience is a record (object)', async () => {
      prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
        makeDraftVersion({ audience: { role: 'clinician' } })
      );

      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value.inferredAudience).toMatchObject({ role: 'clinician' });
    });

    it('omits inferredAudience when version.audience is null', async () => {
      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value).not.toHaveProperty('inferredAudience');
    });

    it('projects questions from their parent section ordinal (sectionOrdinal = section.ordinal)', async () => {
      prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
        makeDraftVersion({
          sections: [
            {
              ordinal: 2,
              title: 'Section C',
              description: null,
              questions: [
                {
                  key: 'qC1',
                  prompt: 'Question in C',
                  type: 'numeric',
                  typeConfig: null,
                  guidelines: null,
                  rationale: null,
                  extractionConfidence: 0.9,
                },
              ],
            },
          ],
        })
      );

      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value.questions[0]).toMatchObject({
        sectionOrdinal: 2,
        key: 'qC1',
        suggestedType: 'numeric',
        extractionConfidence: 0.9,
      });
    });

    it('includes typeConfig when the DB row has a record value for it', async () => {
      prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
        makeDraftVersion({
          sections: [
            {
              ordinal: 0,
              title: 'Ratings',
              description: null,
              questions: [
                {
                  key: 'rating',
                  prompt: 'Rate from 1-5',
                  type: 'likert',
                  typeConfig: { min: 1, max: 5 },
                  guidelines: null,
                  rationale: null,
                  extractionConfidence: 1,
                },
              ],
            },
          ],
        })
      );

      const result = await loadRefinableStructure('qn-1', 'ver-1');
      if (!result.ok) throw new Error('narrowing');

      expect(result.value.questions[0]).toHaveProperty('suggestedTypeConfig', { min: 1, max: 5 });
    });
  });
});
