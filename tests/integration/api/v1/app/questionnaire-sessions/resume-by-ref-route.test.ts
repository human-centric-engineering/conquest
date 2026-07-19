/**
 * Integration test: cross-device resume-by-ref route (session resume).
 *
 * The resolver, rate limiter, and token minter are mocked. Pins the public surface: the tight IP
 * sub-cap (throttling ref enumeration), the generic 404 on any non-match (no
 * enumeration oracle), and that a match re-mints a fresh token bound to the existing session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const rateMock = vi.hoisted(() => ({ resumeByRefLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const resolveMock = vi.hoisted(() => ({ resolveAnonymousResumeByRef: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/resume-by-ref', () => resolveMock);

const tokenMock = vi.hoisted(() => ({ mintSessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/resume-by-ref/route';

const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/resume-by-ref';
function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  rateMock.resumeByRefLimiter.check.mockReturnValue({ success: true });
  resolveMock.resolveAnonymousResumeByRef.mockResolvedValue({
    sessionId: 'sess-1',
    versionId: 'v-1',
    ref: '7F3K9M2P',
    status: 'active',
  });
  tokenMock.mintSessionToken.mockReturnValue({
    token: 'tok.sig',
    expiresAt: new Date('2026-07-17T00:00:00.000Z'),
  });
});

describe('resume-by-ref', () => {
  it('429s when the tight IP sub-cap is exceeded (throttles enumeration)', async () => {
    rateMock.resumeByRefLimiter.check.mockReturnValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req({ ref: '7F3K9M2P' }));
    expect(res.status).toBe(429);
    expect(resolveMock.resolveAnonymousResumeByRef).not.toHaveBeenCalled();
  });

  it('matches a resumable session and re-mints a fresh token', async () => {
    const res = await POST(req({ ref: '7f3k-9m2p' }));
    expect(res.status).toBe(200);
    expect(resolveMock.resolveAnonymousResumeByRef).toHaveBeenCalledWith('7f3k-9m2p');
    expect(tokenMock.mintSessionToken).toHaveBeenCalledWith('sess-1');
    const body = await res.json();
    expect(body.data).toMatchObject({
      session: { id: 'sess-1', versionId: 'v-1' },
      accessToken: 'tok.sig',
      ref: '7F3K9M2P',
    });
  });

  it('404s generically on any non-match, without minting a token', async () => {
    resolveMock.resolveAnonymousResumeByRef.mockResolvedValue(null);
    const res = await POST(req({ ref: 'BADCODE1' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NO_RESUMABLE_SESSION');
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('400s on a missing ref', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(resolveMock.resolveAnonymousResumeByRef).not.toHaveBeenCalled();
  });
});
