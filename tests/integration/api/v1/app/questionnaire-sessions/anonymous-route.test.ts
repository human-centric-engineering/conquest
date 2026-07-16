/**
 * Integration test: no-login anonymous session-create route (F6.1, PR6).
 *
 * The create seam, rate limiter, and token minter are mocked. Pins the public surface: the
 * live-sessions flag gate, the IP-keyed sub-cap, dispatch to createAnonymousSession, the
 * typed-failure → HTTP mapping, and that a success returns the minted access token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const rateMock = vi.hoisted(() => ({ sessionStartLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const createMock = vi.hoisted(() => ({ createAnonymousSession: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => createMock);

const tokenMock = vi.hoisted(() => ({ mintSessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/anonymous/route';

const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/anonymous';
function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

const SESSION = { id: 'sess-anon', status: 'active', versionId: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  rateMock.sessionStartLimiter.check.mockReturnValue({ success: true });
  createMock.createAnonymousSession.mockResolvedValue({
    ok: true,
    session: SESSION,
    resumed: false,
  });
  tokenMock.mintSessionToken.mockReturnValue({
    token: 'tok.sig',
    expiresAt: new Date('2026-06-07T00:00:00.000Z'),
  });
});

describe('anonymous create', () => {
  it('429s when the IP sub-cap is exceeded', async () => {
    rateMock.sessionStartLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(429);
  });

  it('creates an anonymous session and returns the minted access token (201)', async () => {
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(201);
    expect(createMock.createAnonymousSession).toHaveBeenCalledWith('v1');
    expect(tokenMock.mintSessionToken).toHaveBeenCalledWith('sess-anon');
    const body = await res.json();
    expect(body.data).toMatchObject({ session: SESSION, accessToken: 'tok.sig' });
  });

  it('maps a 403 INVITATION_REQUIRED (non-anonymous questionnaire) to 403', async () => {
    createMock.createAnonymousSession.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'This questionnaire requires an invitation',
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITATION_REQUIRED');
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('400s on a missing versionId', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});
