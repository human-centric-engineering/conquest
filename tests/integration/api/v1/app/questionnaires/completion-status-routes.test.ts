/**
 * Integration test: questionnaire completion-status preview route (F4.5).
 *
 * Exercises the POST handler with the DB seam (`prisma`) and the capability
 * dispatcher mocked: gate order (404 master-flag-off before auth; 401/403; scope-404),
 * the deterministic assessment (offer / not_ready / blocked_on_required), and the
 * offer-composition wiring — composed only when the assessment is `offer` AND the
 * completion sub-flag is on, fail-soft, and NOT 404 when the sub-flag is off. The
 * composer capability itself is tested separately (completion-capability.test.ts);
 * this pins the route → context → assessment → dispatch wiring and the no-persistence
 * contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  aiAgent: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);

const rateLimitMock = vi.hoisted(() => ({
  completionLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/completion-status/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_FLAG,
} from '@/lib/app/questionnaire/constants';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/completion-status';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(sessionVal: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(sessionVal);
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

/**
 * A version with one required + one optional slot, coverageThreshold 1 / min 0.
 * `CONFIG_SELECT` fields the selection-context builder reads come from the config row;
 * unspecified ones fall back to DEFAULT_QUESTIONNAIRE_CONFIG.
 */
function versionRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    config: {
      selectionStrategy: 'sequential',
      minQuestionsAnswered: 0,
      coverageThreshold: 1,
      costBudgetUsd: null,
      maxQuestionsPerSession: null,
      voiceEnabled: false,
      contradictionMode: 'off',
      contradictionWindowN: 0,
      anonymousMode: false,
      profileFields: [],
      ...configOverrides,
    },
    sections: [
      {
        id: 's1',
        ordinal: 0,
        questions: [
          {
            id: 'q1-id',
            key: 'goal',
            ordinal: 0,
            weight: 1,
            required: true,
            type: 'free_text',
            prompt: 'What is your goal?',
            tags: [],
          },
          {
            id: 'q2-id',
            key: 'budget',
            ordinal: 1,
            weight: 1,
            required: false,
            type: 'numeric',
            prompt: 'What is your budget?',
            tags: [],
          },
        ],
      },
    ],
  };
}

const AGENT_ROW = { id: 'agent-1', provider: '', model: '', fallbackProviders: [] };

function dispatchOffer() {
  return {
    success: true,
    data: {
      offer: {
        offerMessage: 'Shall I submit?',
        coveredSummary: 'We covered your goal and budget.',
        remainingNote: 'You can still add more.',
      },
    },
  };
}

/** Body answering both questions → full coverage, required satisfied → offer. */
const COMPLETE_BODY = {
  answered: [
    { key: 'goal', confidence: 0.9 },
    { key: 'budget', confidence: 0.8 },
  ],
  recentMessages: ['that covers it'],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Master + completion sub-flag both on by default.
  vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
    Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG || flag === APP_QUESTIONNAIRES_COMPLETION_FLAG)
  );
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(dispatchOffer());
  rateLimitMock.completionLimiter.check.mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0,
  });
});

describe('gate order + auth', () => {
  it('404s when the master flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await POST(req(COMPLETE_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(COMPLETE_BODY), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req(COMPLETE_BODY), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve under the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    expect((await POST(req(COMPLETE_BODY), ctx(PARAMS))).status).toBe(404);
  });
});

describe('assessment', () => {
  it('returns offer with a composed offer when complete and the sub-flag is on', async () => {
    const res = await POST(req(COMPLETE_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assessment.kind).toBe('offer');
    expect(body.data.offer.offerMessage).toBe('Shall I submit?');
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('blocks on a required question and does NOT compose an offer', async () => {
    const res = await POST(req({ answered: [{ key: 'budget', confidence: 0.8 }] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assessment.kind).toBe('blocked_on_required');
    expect(body.data.assessment.requiredUnansweredKeys).toEqual(['goal']);
    expect(body.data.offer).toBeUndefined();
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('is not_ready below the coverage threshold (no offer)', async () => {
    // Answer only the required slot; the optional one leaves coverage at 50% < 100%.
    const res = await POST(req({ answered: [{ key: 'goal', confidence: 0.9 }] }), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.assessment.kind).toBe('not_ready');
    expect(body.data.assessment.unmet).toContain('coverage_below_threshold');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches the composer with covered/remaining recap and the agent binding', async () => {
    await POST(req(COMPLETE_BODY), ctx(PARAMS));
    const [slug, args, context] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_compose_completion_offer');
    expect(args.coverage).toBeCloseTo(1);
    expect(args.coveredSlots.map((s: { key: string }) => s.key).sort()).toEqual(['budget', 'goal']);
    expect(args.remainingSlots).toEqual([]);
    expect(context.entityContext.completionAgent).toMatchObject({ provider: '', model: '' });
  });
});

describe('sub-flag + fail-soft', () => {
  it('returns the assessment without an offer (NOT 404) when the completion sub-flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
    );
    const res = await POST(req(COMPLETE_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assessment.kind).toBe('offer');
    expect(body.data.offer).toBeUndefined();
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('is fail-soft: a composer error yields the assessment + a diagnostic, no offer', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'composition_failed', message: 'boom' },
    });
    const res = await POST(req(COMPLETE_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assessment.kind).toBe('offer');
    expect(body.data.offer).toBeUndefined();
    expect(body.data.diagnostic).toBe('composition_failed');
  });

  it('429s when the per-admin sub-cap is exhausted (before dispatch)', async () => {
    rateLimitMock.completionLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await POST(req(COMPLETE_BODY), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('404s when the completion agent is not seeded (eligible offer path)', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await POST(req(COMPLETE_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});
