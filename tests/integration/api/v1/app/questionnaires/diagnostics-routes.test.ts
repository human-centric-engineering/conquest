/**
 * Integration test: questionnaire diagnostics read routes (F8.5).
 *
 * Pins the route → auth → version-scope → aggregator wiring for the two GET
 * endpoints (version rollup + per-invitation drill-down). The aggregators themselves are
 * unit-tested separately (lib/app/questionnaire/analytics/diagnostics.test.ts); here they're
 * stubbed so the test exercises only the route shell:
 *   - 401 unauthenticated / 403 non-admin
 *   - 404 when the version doesn't resolve under the questionnaire
 *   - 404 when the drill-down aggregator returns null (invitation not on this version)
 *   - 200 + payload on the happy path, with the resolved scope passed to the aggregator
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// Keep the real query schema + scope resolver; stub only the DB-touching aggregators.
const analyticsMock = vi.hoisted(() => ({
  getVersionDiagnostics: vi.fn(),
  getInvitationDiagnostics: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app/questionnaire/analytics')>()),
  ...analyticsMock,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET as getVersion } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/diagnostics/route';
import { GET as getInvitation } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/diagnostics/[invitationId]/route';

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const BASE = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/diagnostics';

function req(suffix = ''): NextRequest {
  return { url: `${BASE}${suffix}`, headers: new Headers() } as unknown as NextRequest;
}
function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const VERSION_PARAMS = { id: 'qn-1', vid: 'v1' };
const INVITE_PARAMS = { id: 'qn-1', vid: 'v1', invitationId: 'inv-1' };

const VERSION_PAYLOAD = {
  versionId: 'v1',
  range: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
  totals: {
    sessions: 0,
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    avgTurnMs: null,
    p95TurnMs: null,
    errorCount: 0,
    errorsBySeverity: { error: 0, warning: 0, info: 0 },
  },
  invitations: [],
  identitySuppressed: false,
};
const INVITE_PAYLOAD = {
  versionId: 'v1',
  invitationId: 'inv-1',
  email: 'ada@example.com',
  name: 'Ada',
  status: 'started',
  sentAt: null,
  openedAt: null,
  registeredAt: null,
  expiresAt: null,
  revokedAt: null,
  sessions: [],
  errors: [],
  totals: {
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    avgTurnMs: null,
    errorCount: 0,
  },
  identitySuppressed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'launched',
  });
  analyticsMock.getVersionDiagnostics.mockResolvedValue(VERSION_PAYLOAD);
  analyticsMock.getInvitationDiagnostics.mockResolvedValue(INVITE_PAYLOAD);
});

describe('GET versions/:vid/diagnostics (version rollup)', () => {
  const agg = analyticsMock.getVersionDiagnostics;

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await getVersion(req(), ctx(VERSION_PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await getVersion(req(), ctx(VERSION_PARAMS))).status).toBe(403);
  });

  it('404s with the error envelope when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await getVersion(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(agg).not.toHaveBeenCalled();
  });

  it('400s on an invalid date query', async () => {
    const res = await getVersion(req('?from=not-a-date'), ctx(VERSION_PARAMS));
    expect(res.status).toBe(400);
    expect(agg).not.toHaveBeenCalled();
  });

  it('200s on the happy path and returns the aggregator payload', async () => {
    const res = await getVersion(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(VERSION_PAYLOAD);
    expect(agg).toHaveBeenCalledTimes(1);
  });

  it('passes the resolved scope (version + round filter) to the aggregator', async () => {
    await getVersion(req('?roundId=r1'), ctx(VERSION_PARAMS));
    const scope = (agg as unknown as Mock).mock.calls[0][0];
    expect(scope.versionId).toBe('v1');
    expect(scope.roundId).toBe('r1');
    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
  });
});

describe('GET versions/:vid/diagnostics/:invitationId (drill-down)', () => {
  const agg = analyticsMock.getInvitationDiagnostics;

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await getInvitation(req('/inv-1'), ctx(INVITE_PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await getInvitation(req('/inv-1'), ctx(INVITE_PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await getInvitation(req('/inv-1'), ctx(INVITE_PARAMS));
    expect(res.status).toBe(404);
    expect(agg).not.toHaveBeenCalled();
  });

  it('404s when the aggregator returns null (invitation not on this version)', async () => {
    analyticsMock.getInvitationDiagnostics.mockResolvedValue(null);
    const res = await getInvitation(req('/inv-1'), ctx(INVITE_PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
  });

  it('200s on the happy path and passes (versionId, invitationId) to the aggregator', async () => {
    const res = await getInvitation(req('/inv-1'), ctx(INVITE_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(INVITE_PAYLOAD);
    expect(agg).toHaveBeenCalledWith('v1', 'inv-1');
  });
});
