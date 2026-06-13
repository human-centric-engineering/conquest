/**
 * Integration test: safeguarding analytics route (F9.6).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/analytics/safeguarding
 *
 * Exercises the full route shell: master-flag gate → admin auth guard →
 * version-scope check → query-param validation → getSafeguardingSummary
 * aggregator invocation → response envelope. The aggregator itself is
 * unit-tested in lib/app/questionnaire/analytics/safeguarding.test.ts; here
 * it's stubbed so the test only exercises the route shell:
 *
 *   - 404 when the master flag is off, before auth (app looks absent)
 *   - 401 unauthenticated / 403 non-admin
 *   - 404 with NOT_FOUND error envelope when the version doesn't resolve
 *   - 400 with error envelope on an invalid date query
 *   - 200 + success envelope on the happy path
 *   - scope (versionId, parsed dates) is forwarded correctly to the aggregator
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

// Keep the real query schema + scope resolver; stub only the DB-touching aggregator.
const analyticsMock = vi.hoisted(() => ({
  getSafeguardingSummary: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app/questionnaire/analytics')>()),
  ...analyticsMock,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/analytics/safeguarding/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { APP_QUESTIONNAIRES_FLAG } from '@/lib/app/questionnaire/constants';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Mock = ReturnType<typeof vi.fn>;

const BASE = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/analytics';
const PARAMS = { id: 'qn-1', vid: 'v1' };

function req(search = ''): NextRequest {
  return { url: `${BASE}/safeguarding${search}`, headers: new Headers() } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const HAPPY_PAYLOAD = {
  versionId: 'v1',
  range: { from: expect.any(String), to: expect.any(String) },
  flagged: 3,
  serious: 1,
  suppressed: false,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: master flag on, admin session, version found, aggregator returns a payload.
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
  analyticsMock.getSafeguardingSummary.mockResolvedValue({
    versionId: 'v1',
    range: { from: '2025-05-14T00:00:00.000Z', to: '2025-06-13T00:00:00.000Z' },
    flagged: 3,
    serious: 1,
    suppressed: false,
  });
});

describe('GET analytics/safeguarding', () => {
  it('404s when the master flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    setAuth(null);

    const res = await GET(req(), ctx(PARAMS));

    expect(res.status).toBe(404);
    // Auth must NOT have been consulted — the app should look absent.
    expect(auth.api.getSession).not.toHaveBeenCalled();
    // Aggregator must not have been called.
    expect(analyticsMock.getSafeguardingSummary).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());

    const res = await GET(req(), ctx(PARAMS));

    expect(res.status).toBe(401);
    expect(analyticsMock.getSafeguardingSummary).not.toHaveBeenCalled();
  });

  it('403s for a non-admin authenticated user', async () => {
    setAuth(mockAuthenticatedUser());

    const res = await GET(req(), ctx(PARAMS));

    expect(res.status).toBe(403);
    expect(analyticsMock.getSafeguardingSummary).not.toHaveBeenCalled();
  });

  it('404s with the NOT_FOUND error envelope when the version does not belong to the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);

    const res = await GET(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(404);
    // Full error envelope — pattern 9 from brittle-patterns.
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
    // Aggregator must not be called when scoping fails.
    expect(analyticsMock.getSafeguardingSummary).not.toHaveBeenCalled();
  });

  it('400s with an error envelope on an invalid date query param', async () => {
    const res = await GET(req('?from=not-a-date'), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBeDefined();
    expect(analyticsMock.getSafeguardingSummary).not.toHaveBeenCalled();
  });

  it('200s on the happy path and wraps the aggregator result in the success envelope', async () => {
    const res = await GET(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Route wraps the result — verify it's the aggregator's payload inside the envelope,
    // not a passthrough of raw mock value without any routing logic.
    expect(body.data).toMatchObject({
      versionId: 'v1',
      flagged: 3,
      serious: 1,
      suppressed: false,
    });
    expect(body.data).toHaveProperty('range');
    expect(analyticsMock.getSafeguardingSummary).toHaveBeenCalledTimes(1);
  });

  it('passes the correct version-scoped AnalyticsScope to the aggregator', async () => {
    await GET(req(), ctx(PARAMS));

    const scope = (analyticsMock.getSafeguardingSummary as unknown as Mock).mock.calls[0][0];

    // The route must forward the vid from the URL params as versionId.
    expect(scope.versionId).toBe('v1');
    // from/to must be Date instances resolved by resolveAnalyticsScope.
    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
    // Default: no tag filter.
    expect(scope.tagIds).toEqual([]);
  });

  it('passes parsed date params into the scope when provided', async () => {
    await GET(req('?from=2025-01-01&to=2025-03-31'), ctx(PARAMS));

    const scope = (analyticsMock.getSafeguardingSummary as unknown as Mock).mock.calls[0][0];

    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
    // Verify the from date reflects the submitted param — proving the route didn't ignore it.
    expect(scope.from.getFullYear()).toBe(2025);
    expect(scope.from.getMonth()).toBe(0); // January (0-indexed)
  });

  it('suppressed=true is forwarded faithfully in the envelope', async () => {
    // The aggregator applies k-anonymity suppression; the route must not strip the flag.
    analyticsMock.getSafeguardingSummary.mockResolvedValue({
      versionId: 'v1',
      range: { from: '2025-05-14T00:00:00.000Z', to: '2025-06-13T00:00:00.000Z' },
      flagged: 0,
      serious: 0,
      suppressed: true,
    });

    const res = await GET(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.suppressed).toBe(true);
    expect(body.data.flagged).toBe(0);
    expect(body.data.serious).toBe(0);
  });

  it('scopes the version lookup to the parent questionnaire id from the URL', async () => {
    await GET(req(), ctx({ id: 'qn-1', vid: 'v1' }));

    expect(prismaMock.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'v1', questionnaireId: 'qn-1' }),
      })
    );
  });
});

// Canonical happy-path shape exported for documentation purposes.
void HAPPY_PAYLOAD;
