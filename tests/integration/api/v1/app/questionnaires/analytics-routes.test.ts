/**
 * Integration test: questionnaire analytics read routes (F8.1).
 *
 * Pins the route → flag-gate → auth → version-scope → query-validation → aggregator
 * wiring for the three GET endpoints (distributions / funnel / cost). The aggregators
 * themselves are unit-tested separately (lib/app/questionnaire/analytics/*.test.ts);
 * here they're stubbed so the test exercises only the route shell:
 *   - 404 when the master flag is off (before auth — the app looks absent)
 *   - 401 unauthenticated / 403 non-admin
 *   - 404 when the version doesn't resolve under the questionnaire
 *   - 400 on an invalid query (bad date)
 *   - 200 + payload on the happy path, with the resolved scope passed to the aggregator
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// Keep the real query schema + scope resolver; stub only the DB-touching aggregators.
const analyticsMock = vi.hoisted(() => ({
  getQuestionDistributions: vi.fn(),
  getCompletionFunnel: vi.fn(),
  getQuestionnaireCostBreakdown: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app/questionnaire/analytics')>()),
  ...analyticsMock,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET as getDistributions } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/analytics/distributions/route';
import { GET as getFunnel } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/analytics/funnel/route';
import { GET as getCost } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/analytics/cost/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { APP_QUESTIONNAIRES_FLAG } from '@/lib/app/questionnaire/constants';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const BASE = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/analytics';
const PARAMS = { id: 'qn-1', vid: 'v1' };

function req(path: 'distributions' | 'funnel' | 'cost', search = ''): NextRequest {
  return { url: `${BASE}/${path}${search}`, headers: new Headers() } as unknown as NextRequest;
}
function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

// The three routes, each paired with its stubbed aggregator + a canned payload.
const ROUTES = [
  {
    name: 'distributions',
    handler: getDistributions,
    agg: analyticsMock.getQuestionDistributions,
    payload: { versionId: 'v1', totalSessions: 3, completedSessions: 1, questions: [] },
  },
  {
    name: 'funnel',
    handler: getFunnel,
    agg: analyticsMock.getCompletionFunnel,
    payload: { versionId: 'v1', stages: [], anonymous: { started: 0, completed: 0 } },
  },
  {
    name: 'cost',
    handler: getCost,
    agg: analyticsMock.getQuestionnaireCostBreakdown,
    payload: { versionId: 'v1', totalCostUsd: 0, byCapability: [], trend: [], topSessions: [] },
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
    Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
  );
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'launched',
  });
  analyticsMock.getQuestionDistributions.mockResolvedValue(ROUTES[0].payload);
  analyticsMock.getCompletionFunnel.mockResolvedValue(ROUTES[1].payload);
  analyticsMock.getQuestionnaireCostBreakdown.mockResolvedValue(ROUTES[2].payload);
});

describe.each(ROUTES)('GET analytics/$name', ({ name, handler, agg, payload }) => {
  const path = name;

  it('404s when the master flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    setAuth(null);
    const res = await handler(req(path), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(agg).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await handler(req(path), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await handler(req(path), ctx(PARAMS))).status).toBe(403);
  });

  it('404s with the error envelope when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await handler(req(path), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(agg).not.toHaveBeenCalled();
  });

  it('400s with the error envelope on an invalid date query', async () => {
    const res = await handler(req(path, '?from=not-a-date'), ctx(PARAMS));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBeDefined();
    expect(agg).not.toHaveBeenCalled();
  });

  it('200s on the happy path and returns the aggregator payload', async () => {
    const res = await handler(req(path), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(payload);
    expect(agg).toHaveBeenCalledTimes(1);
  });

  it('passes the resolved scope (version + parsed tag filter) to the aggregator', async () => {
    await handler(req(path, '?tagIds=t1,t2'), ctx(PARAMS));
    const scope = (agg as unknown as Mock).mock.calls[0][0];
    expect(scope.versionId).toBe('v1');
    expect(scope.tagIds).toEqual(['t1', 't2']);
    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
  });
});
