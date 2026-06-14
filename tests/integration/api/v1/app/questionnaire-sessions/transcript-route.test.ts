/**
 * Integration test: transcript replay route (F7.1 — resume).
 *
 * Pins the route wiring: gate order (flag → load → access), both respondent access modes
 * (authenticated owner / anonymous session token), and that the replayed turns are returned
 * verbatim. The transcript loader (`loadTranscript`) and the session lookup (`prisma`) are
 * mocked, but the REAL `resolveTurnAccess` runs (only the HMAC token verify is stubbed, as in
 * answers-route.test.ts), so 401/403/404 reflect real access logic.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/transcript/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const dbMock = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: dbMock.findUnique } },
}));

const transcriptMock = vi.hoisted(() => ({ loadTranscript: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript', () => transcriptMock);

// Real resolveTurnAccess runs; stub only the token verify.
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/transcript/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/transcript';

function req(headers: Record<string, string> = {}): NextRequest {
  return { url: URL, headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const TURNS = [
  { role: 'assistant', content: 'Opening question?' },
  { role: 'user', content: 'My answer' },
  {
    role: 'assistant',
    content: 'Follow-up?',
    warnings: [{ code: 'seriousness', message: "Let's keep it genuine." }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  dbMock.findUnique.mockResolvedValue({ id: 'sess-1', respondentUserId: USER });
  transcriptMock.loadTranscript.mockResolvedValue(TURNS);
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before load or access', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(dbMock.findUnique).not.toHaveBeenCalled();
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });
});

describe('authenticated access', () => {
  it('returns the replayed transcript verbatim to the owner', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { turns: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.turns).toEqual(TURNS);
    expect(transcriptMock.loadTranscript).toHaveBeenCalledWith('sess-1');
  });

  it('403s an authenticated user who does not own the session', async () => {
    // The signed-in user (default mock id) is not this session's respondent.
    dbMock.findUnique.mockResolvedValue({ id: 'sess-1', respondentUserId: 'a-different-user' });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });
});

describe('anonymous access', () => {
  beforeEach(() => {
    // Anonymous session: no owner; access rides the signed token.
    dbMock.findUnique.mockResolvedValue({ id: 'sess-1', respondentUserId: null });
    setAuth(null);
  });

  it('returns the transcript for a valid session token', async () => {
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    const res = await GET(req({ 'x-session-token': 'tok' }), ctx);
    expect(res.status).toBe(200);
    expect(transcriptMock.loadTranscript).toHaveBeenCalledWith('sess-1');
  });

  it('401s when the token is missing', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });

  it('401s when the token is for a different session', async () => {
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'other' });
    const res = await GET(req({ 'x-session-token': 'tok' }), ctx);
    expect(res.status).toBe(401);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });
});
