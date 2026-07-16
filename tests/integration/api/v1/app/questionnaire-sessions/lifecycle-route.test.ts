/**
 * Integration test: respondent pause/resume route (F7.3).
 *
 * Pins the route wiring: gate order (flag → load → access → anonymous-refusal →
 * transition), the signed-in-only rule (anonymous → 403 PAUSE_NOT_PERMITTED), the
 * resume payload (status + answers so far), and that an illegal transition maps to 409.
 * The sessions seam is mocked; the REAL `resolveTurnAccess` runs (only the HMAC token
 * verify is stubbed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const dbMock = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => dbMock);

const sessionsMock = vi.hoisted(() => ({
  pauseSession: vi.fn(),
  resumeSession: vi.fn(),
  abandonSession: vi.fn(),
  loadSessionResumeState: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => sessionsMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/lifecycle/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/lifecycle';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    url: URL,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
    id: 'sess-1',
    respondentUserId: USER,
  });
  sessionsMock.pauseSession.mockResolvedValue('paused');
  sessionsMock.resumeSession.mockResolvedValue('active');
  sessionsMock.abandonSession.mockResolvedValue('abandoned');
  sessionsMock.loadSessionResumeState.mockResolvedValue({
    status: 'active',
    answeredSlots: [{ slotKey: 'role', value: 'Engineer', provenance: 'direct', confidence: 0.9 }],
  });
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await POST(req({ action: 'pause' }), ctx);
    expect(res.status).toBe(404);
    expect(dbMock.prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist (before access)', async () => {
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    const res = await POST(req({ action: 'pause' }), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req({ action: 'pause' }), ctx);
    expect(res.status).toBe(401);
    expect(sessionsMock.pauseSession).not.toHaveBeenCalled();
  });

  it('403s when the session belongs to another user', async () => {
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      respondentUserId: 'someone-else',
    });
    const res = await POST(req({ action: 'pause' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });
});

describe('anonymous refusal (pause/resume signed-in only)', () => {
  function asAnonymousCaller(): void {
    setAuth(mockUnauthenticatedUser());
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      id: 'sess-1',
      respondentUserId: null,
    });
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
  }

  it('403s a valid anonymous caller pausing — pause is not available to no-login sessions', async () => {
    asAnonymousCaller();
    const res = await POST(req({ action: 'pause' }, { 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('PAUSE_NOT_PERMITTED');
    expect(sessionsMock.pauseSession).not.toHaveBeenCalled();
  });

  it('403s a valid anonymous caller resuming', async () => {
    asAnonymousCaller();
    const res = await POST(req({ action: 'resume' }, { 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('PAUSE_NOT_PERMITTED');
    expect(sessionsMock.resumeSession).not.toHaveBeenCalled();
  });

  it('ALLOWS a valid anonymous caller to abandon (backs the no-login "Start new" flow)', async () => {
    asAnonymousCaller();
    const res = await POST(req({ action: 'abandon' }, { 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('abandoned');
    expect(sessionsMock.abandonSession).toHaveBeenCalledWith('sess-1', {
      reason: 'respondent_abandon',
    });
  });
});

describe('abandon', () => {
  it('200s and abandons the session for the authed owner', async () => {
    const res = await POST(req({ action: 'abandon' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('abandoned');
    expect(sessionsMock.abandonSession).toHaveBeenCalledWith('sess-1', {
      reason: 'respondent_abandon',
    });
  });

  it('409s when the state machine rejects abandoning a terminal session', async () => {
    sessionsMock.abandonSession.mockRejectedValue(
      new SessionTransitionError('completed', 'abandoned')
    );
    const res = await POST(req({ action: 'abandon' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details.from).toBe('completed');
    expect(body.error.details.to).toBe('abandoned');
  });
});

describe('pause', () => {
  it('200s and pauses the session with a respondent reason', async () => {
    const res = await POST(req({ action: 'pause' }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('paused');
    expect(sessionsMock.pauseSession).toHaveBeenCalledWith('sess-1', {
      reason: 'respondent_pause',
    });
  });
});

describe('resume', () => {
  it('200s and returns the resume state (status + answers so far)', async () => {
    const res = await POST(req({ action: 'resume' }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('active');
    expect(body.data.answeredSlots).toHaveLength(1);
    expect(sessionsMock.resumeSession).toHaveBeenCalledWith('sess-1', {
      reason: 'respondent_resume',
    });
  });
});

describe('illegal transition', () => {
  it('409s when the state machine rejects the move', async () => {
    sessionsMock.resumeSession.mockRejectedValue(new SessionTransitionError('active', 'active'));
    const res = await POST(req({ action: 'resume' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details.from).toBe('active');
    expect(body.error.details.to).toBe('active');
  });
});

describe('validation', () => {
  it('400s an unknown action', async () => {
    const res = await POST(req({ action: 'destroy' }), ctx);
    expect(res.status).toBe(400);
    expect(sessionsMock.pauseSession).not.toHaveBeenCalled();
  });
});
