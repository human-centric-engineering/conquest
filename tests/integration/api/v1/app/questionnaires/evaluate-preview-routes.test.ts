/**
 * Integration test: design-time evaluation preview route (F5.1).
 *
 * Exercises the POST handler with the DB seam (`prisma`) and the capability dispatcher
 * mocked: gate order (404 master-flag-off before auth; 404 sub-flag-off after auth),
 * 401/403, scope-404, not-configured-404 (no judges seeded), the rate-limit 429, the
 * panel fan-out (one dispatch per dimension), the dimension subset, and the fail-soft
 * per-judge path (one judge errors, the rest still return). The capability itself is
 * tested separately (evaluate-structure-capability.test.ts); this pins the route →
 * loader → panel wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  aiAgent: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

const rateLimitMock = vi.hoisted(() => ({
  designEvaluationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluate-preview/route';

import { auth } from '@/lib/auth/config';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
} from '@/lib/app/questionnaire/evaluation';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/evaluate-preview';

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

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

/** A minimal version graph the loader maps to a structure DTO. */
function versionRow() {
  return {
    goal: 'Understand onboarding friction.',
    audience: { role: 'Engineer' },
    sections: [
      {
        title: 'Background',
        description: null,
        questions: [
          {
            key: 'q_role',
            prompt: 'What is your role?',
            type: 'free_text',
            required: true,
            guidelines: null,
          },
        ],
      },
    ],
  };
}

/** All seven judge agents, as the route's findMany returns them. */
function allJudgeAgents() {
  return EVALUATION_DIMENSIONS.map((d) => ({
    slug: EVALUATION_DIMENSION_SPECS[d].slug,
    id: `agent-${d}`,
    provider: '',
    model: '',
    fallbackProviders: [],
  }));
}

/** A successful verdict dispatch for whatever dimension was requested. */
function dispatchSuccess(dimension: string) {
  return {
    success: true,
    data: {
      verdict: {
        dimension,
        score: 0.8,
        findings: [
          {
            targetKey: 'q_role',
            severity: 'minor',
            proposedChange: 'Tighten wording.',
            rationale: 'Slightly vague.',
          },
        ],
      },
    },
  };
}

const VALID_BODY = {};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
  prismaMock.aiAgent.findMany.mockResolvedValue(allJudgeAgents());
  // Echo the dispatched dimension back in the verdict.
  dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) =>
    Promise.resolve(dispatchSuccess((args as { dimension: string }).dimension))
  );
  rateLimitMock.designEvaluationLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(VALID_BODY), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req(VALID_BODY), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve under the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    // Pin the error envelope shape, not just the status.
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error.code).toBe('string');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('404s (not configured) when no judge agents are seeded', async () => {
    prismaMock.aiAgent.findMany.mockResolvedValue([]);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error.code).toBe('string');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('429s when the per-admin sub-cap is exhausted (before dispatch)', async () => {
    rateLimitMock.designEvaluationLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('panel wiring', () => {
  it('runs the whole panel by default — one dispatch per dimension', async () => {
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.results).toHaveLength(EVALUATION_DIMENSIONS.length);
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(
      EVALUATION_DIMENSIONS.length
    );
    expect(body.data.summary.dimensionsRun).toBe(EVALUATION_DIMENSIONS.length);
    expect(body.data.summary.dimensionsFailed).toBe(0);
    // Each result carries a verdict tagged with its dimension.
    for (const result of body.data.results) {
      expect(result.verdict.dimension).toBe(result.dimension);
    }
  });

  it('runs only the requested dimensions when a subset is given', async () => {
    const res = await POST(req({ dimensions: ['clarity', 'coverage'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toHaveLength(2);
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(2);
    const dims = body.data.results.map((r: { dimension: string }) => r.dimension).sort();
    expect(dims).toEqual(['clarity', 'coverage']);
  });

  it('dedupes a repeated dimension in the request', async () => {
    const res = await POST(req({ dimensions: ['clarity', 'clarity'] }), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.results).toHaveLength(1);
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('400s on an unknown dimension', async () => {
    const res = await POST(req({ dimensions: ['vibes'] }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('aggregates total findings across the panel', async () => {
    const res = await POST(req({ dimensions: ['clarity', 'coverage'] }), ctx(PARAMS));
    const body = await res.json();
    // One finding per successful judge.
    expect(body.data.summary.totalFindings).toBe(2);
  });
});

describe('fail-soft per judge', () => {
  it('returns a diagnostic for a failed judge and verdicts for the rest', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'coverage') {
        return Promise.resolve({ success: false, error: { code: 'evaluation_failed' } });
      }
      return Promise.resolve(dispatchSuccess(dimension));
    });

    const res = await POST(req({ dimensions: ['clarity', 'coverage'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();

    const coverage = body.data.results.find(
      (r: { dimension: string }) => r.dimension === 'coverage'
    );
    const clarity = body.data.results.find((r: { dimension: string }) => r.dimension === 'clarity');
    expect(coverage).toBeDefined();
    expect(clarity).toBeDefined();
    expect(coverage.verdict).toBeUndefined();
    expect(coverage.diagnostic).toBe('evaluation_failed');
    // Pin the surviving verdict's shape, not merely its presence.
    expect(clarity.verdict).toMatchObject({ dimension: 'clarity', score: expect.any(Number) });
    expect(body.data.summary.dimensionsRun).toBe(1);
    expect(body.data.summary.dimensionsFailed).toBe(1);
  });

  it('returns judge_not_configured for a dimension whose agent is missing', async () => {
    // Only the clarity judge is seeded; request clarity + ordering.
    prismaMock.aiAgent.findMany.mockResolvedValue([
      {
        slug: EVALUATION_DIMENSION_SPECS.clarity.slug,
        id: 'agent-clarity',
        provider: '',
        model: '',
        fallbackProviders: [],
      },
    ]);

    const res = await POST(req({ dimensions: ['clarity', 'ordering'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ordering = body.data.results.find(
      (r: { dimension: string }) => r.dimension === 'ordering'
    );
    expect(ordering.diagnostic).toBe('judge_not_configured');
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('degrades a thrown dispatch to a diagnostic instead of 5xxing the whole panel', async () => {
    // The dispatcher can throw on an infrastructure fault (e.g. registry DB load);
    // under one Promise.all an unguarded throw would reject the entire request.
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'coverage') return Promise.reject(new Error('registry load failed'));
      return Promise.resolve(dispatchSuccess(dimension));
    });

    const res = await POST(req({ dimensions: ['clarity', 'coverage'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    const coverage = body.data.results.find(
      (r: { dimension: string }) => r.dimension === 'coverage'
    );
    const clarity = body.data.results.find((r: { dimension: string }) => r.dimension === 'clarity');
    expect(coverage.diagnostic).toBe('dispatch_error');
    expect(coverage.verdict).toBeUndefined();
    expect(clarity.verdict).toBeDefined();
    expect(body.data.summary.dimensionsRun).toBe(1);
    expect(body.data.summary.dimensionsFailed).toBe(1);
  });
});
