/**
 * Integration test: questionnaire read routes (P2 / F2.1a).
 *
 * Exercises the HTTP orchestration of the three read endpoints with the DB seam
 * (`_lib/list`, `_lib/detail`) mocked — the gate order, auth, 404 mapping, and
 * response envelope. The enriched-query correctness (no N+1) and the stored
 * provenance (`goalProvenance`/`audienceProvenance`) are unit-tested separately
 * (list.test.ts, detail.test.ts).
 *
 *   GET /api/v1/app/questionnaires                       — list
 *   GET /api/v1/app/questionnaires/:id                   — detail
 *   GET /api/v1/app/questionnaires/:id/versions/:vid     — version graph
 *
 * Covers per route: 404 flag-off · 401 unauth · 403 non-admin · 200/404 happy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

// Keep the real Zod query schema; mock only the DB query.
vi.mock('@/app/api/v1/app/questionnaires/_lib/list', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/list')>();
  return { ...real, listQuestionnaires: vi.fn() };
});
vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getQuestionnaireDetail: vi.fn(),
  getVersionGraph: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET as listGET } from '@/app/api/v1/app/questionnaires/route';
import { GET as detailGET } from '@/app/api/v1/app/questionnaires/[id]/route';
import { GET as versionGET } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { listQuestionnaires } from '@/app/api/v1/app/questionnaires/_lib/list';
import {
  getQuestionnaireDetail,
  getVersionGraph,
} from '@/app/api/v1/app/questionnaires/_lib/detail';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(url = 'http://localhost:3000/api/v1/app/questionnaires'): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
});

describe('GET /api/v1/app/questionnaires (list)', () => {
  it('404s when the feature flag is off (before auth)', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await listGET(req());
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(listQuestionnaires).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await listGET(req());
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin session', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await listGET(req());
    expect(res.status).toBe(403);
  });

  it('returns 200 with the enriched page and pagination meta', async () => {
    (listQuestionnaires as unknown as Mock).mockResolvedValue({
      items: [
        {
          id: 'qn-1',
          title: 'Onboarding',
          status: 'draft',
          versionCount: 1,
          latestVersion: { id: 'ver-1', versionNumber: 1, status: 'draft' },
          sectionCount: 2,
          questionCount: 5,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      total: 1,
    });
    const res = await listGET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].questionCount).toBe(5);
    expect(body.meta).toMatchObject({ page: 1, limit: 25, total: 1, totalPages: 1 });
  });

  it('passes parsed query params (status, search, paging) to the read model', async () => {
    (listQuestionnaires as unknown as Mock).mockResolvedValue({ items: [], total: 0 });
    await listGET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires?page=2&limit=10&q=intake&status=launched'
      )
    );
    expect(listQuestionnaires).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 10, q: 'intake', status: 'launched' })
    );
  });

  it('400s on an invalid status filter', async () => {
    const res = await listGET(req('http://localhost:3000/api/v1/app/questionnaires?status=bogus'));
    expect(res.status).toBe(400);
    expect(listQuestionnaires).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/app/questionnaires/:id (detail)', () => {
  it('404s when the feature flag is off (before auth)', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await detailGET(req(), ctx({ id: 'qn-1' }));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await detailGET(req(), ctx({ id: 'qn-1' }));
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin session', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await detailGET(req(), ctx({ id: 'qn-1' }));
    expect(res.status).toBe(403);
  });

  it('404s when the questionnaire is unknown', async () => {
    (getQuestionnaireDetail as unknown as Mock).mockResolvedValue(null);
    const res = await detailGET(req(), ctx({ id: 'missing' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 200 with the questionnaire detail', async () => {
    (getQuestionnaireDetail as unknown as Mock).mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      versions: [],
    });
    const res = await detailGET(req(), ctx({ id: 'qn-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('qn-1');
    expect(getQuestionnaireDetail).toHaveBeenCalledWith('qn-1');
  });
});

describe('GET /api/v1/app/questionnaires/:id/versions/:vid (graph)', () => {
  it('404s when the feature flag is off (before auth)', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await versionGET(req(), ctx({ id: 'qn-1', vid: 'ver-1' }));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await versionGET(req(), ctx({ id: 'qn-1', vid: 'ver-1' }));
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin session', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await versionGET(req(), ctx({ id: 'qn-1', vid: 'ver-1' }));
    expect(res.status).toBe(403);
  });

  it('404s when the version is unknown / mismatched', async () => {
    (getVersionGraph as unknown as Mock).mockResolvedValue(null);
    const res = await versionGET(req(), ctx({ id: 'qn-1', vid: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('returns 200 with the version graph and scopes by both ids', async () => {
    (getVersionGraph as unknown as Mock).mockResolvedValue({
      id: 'ver-1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'draft',
      goal: 'Collect details',
      audience: { role: 'new hire' },
      goalProvenance: 'inferred',
      audienceProvenance: { role: 'inferred' },
      sections: [],
    });
    const res = await versionGET(req(), ctx({ id: 'qn-1', vid: 'ver-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.goalProvenance).toBe('inferred');
    expect(getVersionGraph).toHaveBeenCalledWith('qn-1', 'ver-1');
  });
});
