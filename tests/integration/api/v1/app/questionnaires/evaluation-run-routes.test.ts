/**
 * Integration test: design-time evaluation run routes (F5.2).
 *
 * Pins the persisting POST and the read GET (list + detail) with the DB seam (`prisma`,
 * including `$transaction`) and the capability dispatcher mocked. Covers:
 *   - POST 401/403, scope-404, not-configured-404, the 429 sub-cap;
 *   - POST persistence: the derived terminal status (completed / partial / failed), the
 *     per-judge finding rows, and that the response is the full run detail;
 *   - GET list: version-scope 404 and newest-first paged headers;
 *   - GET detail: version-scope 404, run-not-found 404, and the findings payload.
 * The panel fan-out itself is unit-tested in run-panel.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  aiAgent: { findMany: vi.fn() },
  appQuestionnaireEvaluationRun: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  appQuestionnaireEvaluationFinding: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);

// The panel flushes capability handlers before dispatching; here it's a no-op so the
// mocked dispatcher stands alone (the real flush is covered by the registry's own tests).
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

const rateLimitMock = vi.hoisted(() => ({
  designEvaluationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  POST,
  GET as LIST,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/route';
import { GET as DETAIL } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/[runId]/route';

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

const BASE = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/evaluations';
const PARAMS = { id: 'qn-1', vid: 'v1' };

function req(body: unknown, url = BASE): NextRequest {
  return {
    url,
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

/** The version graph row `buildEvaluationStructure` maps to a structure DTO. */
function versionGraphRow() {
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

/** The scoped version row `loadScopedVersion` returns (GET routes). */
function scopedVersionRow() {
  return { id: 'v1', questionnaireId: 'qn-1', versionNumber: 1, status: 'draft' };
}

function allJudgeAgents() {
  return EVALUATION_DIMENSIONS.map((d) => ({
    slug: EVALUATION_DIMENSION_SPECS[d].slug,
    id: `agent-${d}`,
    provider: '',
    model: '',
    fallbackProviders: [],
  }));
}

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
            rationale: 'Vague.',
          },
        ],
      },
    },
  };
}

/** A persisted run-detail row the re-read / detail GET returns. */
function persistedRunRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-06-05T12:00:00Z');
  return {
    id: 'run-1',
    versionId: 'v1',
    questionnaireId: 'qn-1',
    status: 'completed',
    triggeredByUserId: 'admin-1',
    dimensionsRequested: 1,
    dimensionsRun: 1,
    dimensionsFailed: 0,
    totalFindings: 1,
    dimensionSummary: [{ dimension: 'clarity', score: 0.8, findingCount: 1, diagnostic: null }],
    error: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    findings: [
      {
        id: 'f-1',
        dimension: 'clarity',
        ordinal: 0,
        targetKey: 'q_role',
        severity: 'minor',
        proposedChange: 'Tighten wording.',
        rationale: 'Vague.',
        sourceQuote: null,
        status: 'pending',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionGraphRow());
  prismaMock.aiAgent.findMany.mockResolvedValue(allJudgeAgents());
  dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) =>
    Promise.resolve(dispatchSuccess((args as { dimension: string }).dimension))
  );
  rateLimitMock.designEvaluationLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  // $transaction runs the callback against the same mock (the tx interface is a subset).
  prismaMock.$transaction.mockImplementation((cb: (tx: typeof prismaMock) => unknown) =>
    cb(prismaMock)
  );
  prismaMock.appQuestionnaireEvaluationRun.create.mockResolvedValue({ id: 'run-1' });
  prismaMock.appQuestionnaireEvaluationFinding.createMany.mockResolvedValue({ count: 1 });
  // The re-read after persist (and the detail GET) returns the persisted row.
  prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue(persistedRunRow());
});

describe('POST evaluations — gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve under the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('404s (not configured) when no judge agents are seeded', async () => {
    prismaMock.aiAgent.findMany.mockResolvedValue([]);
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('429s when the per-admin sub-cap is exhausted (before dispatch)', async () => {
    rateLimitMock.designEvaluationLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('POST evaluations — persistence', () => {
  it('persists a completed run with one finding per judge and returns the detail', async () => {
    const res = await POST(req({ dimensions: ['clarity'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('run-1');
    expect(body.data.findings).toHaveLength(1);
    expect(body.data.findings[0]).toMatchObject({ dimension: 'clarity', status: 'pending' });

    // The run header was written with the derived completed status + tallies.
    const createArg = prismaMock.appQuestionnaireEvaluationRun.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      versionId: 'v1',
      questionnaireId: 'qn-1',
      status: 'completed',
      // The session admin id (a generated cuid from the mock) — pin the type, not the value.
      triggeredByUserId: expect.any(String),
      dimensionsRequested: 1,
      dimensionsRun: 1,
      dimensionsFailed: 0,
      totalFindings: 1,
      error: null,
    });
    // One finding row created for the single judge.
    const manyArg = prismaMock.appQuestionnaireEvaluationFinding.createMany.mock.calls[0][0];
    expect(manyArg.data).toHaveLength(1);
    expect(manyArg.data[0]).toMatchObject({ runId: 'run-1', dimension: 'clarity', ordinal: 0 });
  });

  it('derives status=partial when some judges fail', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'coverage') {
        return Promise.resolve({ success: false, error: { code: 'evaluation_failed' } });
      }
      return Promise.resolve(dispatchSuccess(dimension));
    });
    const res = await POST(req({ dimensions: ['clarity', 'coverage'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const createArg = prismaMock.appQuestionnaireEvaluationRun.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      status: 'partial',
      dimensionsRun: 1,
      dimensionsFailed: 1,
      error: null,
    });
  });

  it('derives status=failed (with an error note, no findings) when every judge fails', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'evaluation_failed' },
    });
    const res = await POST(req({ dimensions: ['clarity'] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const createArg = prismaMock.appQuestionnaireEvaluationRun.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      status: 'failed',
      dimensionsRun: 0,
      dimensionsFailed: 1,
      error: 'all_judges_failed',
    });
    // No findings → createMany skipped.
    expect(prismaMock.appQuestionnaireEvaluationFinding.createMany).not.toHaveBeenCalled();
  });

  it('500s when the run vanishes immediately after persist (internal fault)', async () => {
    // The write succeeds in the transaction, but the re-read returns null — the
    // `persistEvaluationRun` guard throws, which the auth wrapper maps to a 500.
    prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue(null);
    const res = await POST(req({ dimensions: ['clarity'] }), ctx(PARAMS));
    expect(res.status).toBe(500);
    expect(prismaMock.appQuestionnaireEvaluationRun.create).toHaveBeenCalled();
  });

  it('400s on an unknown dimension', async () => {
    const res = await POST(req({ dimensions: ['vibes'] }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });
});

describe('GET evaluations — list', () => {
  beforeEach(() => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(scopedVersionRow());
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await LIST(req({}), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await LIST(req({}), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version is not scoped to the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await LIST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
  });

  it('returns paged run headers (newest-first) with total meta', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findMany.mockResolvedValue([persistedRunRow()]);
    prismaMock.appQuestionnaireEvaluationRun.count.mockResolvedValue(1);
    const res = await LIST(req({}), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('run-1');
    expect(body.meta.total).toBe(1);
    // Ordered newest-first.
    const findManyArg = prismaMock.appQuestionnaireEvaluationRun.findMany.mock.calls[0][0];
    expect(findManyArg.orderBy).toEqual({ createdAt: 'desc' });
    expect(findManyArg.where).toEqual({ versionId: 'v1' });
  });
});

describe('GET evaluations — detail', () => {
  const DETAIL_PARAMS = { id: 'qn-1', vid: 'v1', runId: 'run-1' };
  const DETAIL_URL = `${BASE}/run-1`;

  beforeEach(() => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(scopedVersionRow());
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await DETAIL(req({}, DETAIL_URL), ctx(DETAIL_PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await DETAIL(req({}, DETAIL_URL), ctx(DETAIL_PARAMS))).status).toBe(403);
  });

  it('404s when the version is not scoped to the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await DETAIL(req({}, DETAIL_URL), ctx(DETAIL_PARAMS));
    expect(res.status).toBe(404);
  });

  it('404s when the run is not found for the version', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue(null);
    const res = await DETAIL(req({}, DETAIL_URL), ctx(DETAIL_PARAMS));
    expect(res.status).toBe(404);
  });

  it('returns the run with its findings', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue(persistedRunRow());
    const res = await DETAIL(req({}, DETAIL_URL), ctx(DETAIL_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('run-1');
    expect(body.data.findings).toHaveLength(1);
    expect(body.data.dimensionSummary[0]).toMatchObject({ dimension: 'clarity', score: 0.8 });
    // Detail read is version-scoped.
    const findFirstArg = prismaMock.appQuestionnaireEvaluationRun.findFirst.mock.calls[0][0];
    expect(findFirstArg.where).toEqual({ id: 'run-1', versionId: 'v1' });
  });

  it('degrades a malformed stored dimensionSummary to an empty array', async () => {
    // A tampered/corrupt JSON blob must not throw — parseDimensionSummary degrades to [].
    prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue(
      persistedRunRow({ dimensionSummary: 'not-an-array' })
    );
    const res = await DETAIL(req({}, DETAIL_URL), ctx(DETAIL_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dimensionSummary).toEqual([]);
  });
});
