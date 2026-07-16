/**
 * Integration test: respondent intro / splash read route.
 *
 * Pins the route wiring: gate order (live-sessions flag → load → access → intro flag), both
 * respondent access modes (authenticated owner / anonymous session token), the platform-flag-off
 * short-circuit (returns `intro: null` without resolving), and that the resolved intro is returned.
 * The resolver (`resolveSessionIntro`) and session lookup are mocked, but the REAL `resolveTurnAccess`
 * runs (only the HMAC token verify is stubbed), so 401/403/404 reflect real access logic.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/intro/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const dbMock = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: dbMock.findUnique } },
}));

const introMock = vi.hoisted(() => ({ resolveSessionIntro: vi.fn() }));
vi.mock('@/lib/app/questionnaire/intro/resolve', () => introMock);

// Real resolveTurnAccess runs; stub only the token verify.
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/intro/route';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/intro';

function req(headers: Record<string, string> = {}): NextRequest {
  return { url: URL, headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const RESOLVED_INTRO = {
  enabled: true,
  questionnaireTitle: 'Team Health Check',
  background: '',
  copy: {
    howItWorks: { heading: 'How it works', body: 'body' },
    whatYouGet: null,
    goodToKnow: [],
    buttonLabel: 'Begin',
  },
};

function session(over: Record<string, unknown> = {}) {
  return { id: 'sess-1', respondentUserId: USER, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAuthenticatedUser());
  dbMock.findUnique.mockResolvedValue(session());
  introMock.resolveSessionIntro.mockResolvedValue(RESOLVED_INTRO);
});

describe('gate order', () => {
  it('404s when the session does not exist', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(introMock.resolveSessionIntro).not.toHaveBeenCalled();
  });
});

describe('authenticated access', () => {
  it('returns the resolved intro to the owner', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { intro: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.intro).toEqual(RESOLVED_INTRO);
    expect(introMock.resolveSessionIntro).toHaveBeenCalledWith('sess-1');
  });

  it('403s an authenticated user who does not own the session', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: 'a-different-user' }));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
    expect(introMock.resolveSessionIntro).not.toHaveBeenCalled();
  });
});

describe('anonymous access', () => {
  beforeEach(() => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: null }));
    setAuth(null);
  });

  it('returns the intro for a valid session token', async () => {
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    const res = await GET(req({ 'x-session-token': 'tok' }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { intro: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.intro).toEqual(RESOLVED_INTRO);
    expect(introMock.resolveSessionIntro).toHaveBeenCalledWith('sess-1');
  });

  it('401s when the token is missing', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(introMock.resolveSessionIntro).not.toHaveBeenCalled();
  });
});
