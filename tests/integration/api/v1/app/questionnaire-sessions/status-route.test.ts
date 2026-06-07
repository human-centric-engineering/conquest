/**
 * Integration test: session lifecycle/status read route (F7.3).
 *
 * Pins the route wiring: gate order (flag → load → access), both respondent access modes,
 * and that the projected `SessionStatusView` is returned verbatim. The DB read seam
 * (`loadSessionStatus`) is mocked — its pure builder is unit-tested separately — but the
 * REAL `resolveTurnAccess` runs (only the HMAC token verify is stubbed), so 401/403/404
 * reflect real access logic. Mirrors answers-route.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const statusMock = vi.hoisted(() => ({ loadSessionStatus: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-status', () => statusMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/status/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/status';

function req(headers: Record<string, string> = {}): NextRequest {
  return { url: URL, headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function view(over: Partial<SessionStatusView> = {}): SessionStatusView {
  return {
    status: 'active',
    completion: {
      kind: 'offer',
      coverage: 0.85,
      answeredCount: 5,
      requiredUnansweredKeys: [],
      capReached: false,
    },
    cost: null,
    anonymous: false,
    ...over,
  };
}

function loaded(respondentUserId: string | null, v: SessionStatusView = view()) {
  return { session: { id: 'sess-1', respondentUserId }, view: v };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  statusMock.loadSessionStatus.mockResolvedValue(loaded(USER));
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(statusMock.loadSessionStatus).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist (before access)', async () => {
    statusMock.loadSessionStatus.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('500s via handleAPIError when the load seam throws unexpectedly', async () => {
    statusMock.loadSessionStatus.mockRejectedValue(new Error('db unavailable'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
  });
});

describe('authenticated access', () => {
  it('200s the projected view for the owning user', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.completion.kind).toBe('offer');
    expect(body.data.status).toBe('active');
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('403s when the session belongs to another respondent', async () => {
    statusMock.loadSessionStatus.mockResolvedValue(loaded('someone-else'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });
});

describe('anonymous (no-login) access', () => {
  it('200s a valid session-token-bearing anonymous caller', async () => {
    setAuth(mockUnauthenticatedUser());
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    statusMock.loadSessionStatus.mockResolvedValue(loaded(null, view({ anonymous: true })));
    const res = await GET(req({ 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.anonymous).toBe(true);
  });

  it('401s an anonymous session with no token', async () => {
    setAuth(mockUnauthenticatedUser());
    statusMock.loadSessionStatus.mockResolvedValue(loaded(null));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('SESSION_TOKEN_REQUIRED');
  });
});

describe('payload', () => {
  it('reports a cost tier when capped but never the raw spend', async () => {
    statusMock.loadSessionStatus.mockResolvedValue(loaded(USER, view({ cost: { tier: 'soft' } })));
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body.data.cost).toEqual({ tier: 'soft' });
    expect(JSON.stringify(body)).not.toMatch(/spentUsd|capUsd/);
  });
});
