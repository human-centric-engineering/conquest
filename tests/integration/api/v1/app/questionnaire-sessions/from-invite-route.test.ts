/**
 * Integration test: frictionless invite session-create route (invitations Phase B).
 *
 * The create seam, rate limiter, and token minter are mocked. Pins the public surface:
 * the IP-keyed sub-cap, dispatch to createSessionFromInviteToken, the typed-failure → HTTP
 * mapping, and that a success returns the minted access token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const rateMock = vi.hoisted(() => ({ sessionStartLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const createMock = vi.hoisted(() => ({ createSessionFromInviteToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => createMock);

const tokenMock = vi.hoisted(() => ({ mintSessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/from-invite/route';

const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/from-invite';
function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

const SESSION = { id: 'sess-invite', status: 'active', versionId: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  rateMock.sessionStartLimiter.check.mockReturnValue({ success: true });
  createMock.createSessionFromInviteToken.mockResolvedValue({
    ok: true,
    session: SESSION,
    resumed: false,
  });
  tokenMock.mintSessionToken.mockReturnValue({
    token: 'tok.sig',
    expiresAt: new Date('2026-06-07T00:00:00.000Z'),
  });
});

describe('from-invite create', () => {
  it('429s when the IP sub-cap is exceeded', async () => {
    rateMock.sessionStartLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req({ inviteToken: 'tok-1' }));
    expect(res.status).toBe(429);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });

  it('keys the IP sub-cap with the invite: prefix', async () => {
    await POST(req({ inviteToken: 'tok-1' }));
    expect(rateMock.sessionStartLimiter.check).toHaveBeenCalledWith('invite:203.0.113.7');
  });

  it('creates a session from the token and returns the minted access token (201)', async () => {
    const res = await POST(req({ inviteToken: 'tok-1' }));
    expect(res.status).toBe(201);
    expect(createMock.createSessionFromInviteToken).toHaveBeenCalledWith('tok-1');
    expect(tokenMock.mintSessionToken).toHaveBeenCalledWith('sess-invite');
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      session: SESSION,
      accessToken: 'tok.sig',
      expiresAt: '2026-06-07T00:00:00.000Z',
    });
  });

  it('maps a typed create failure to its status and does not mint a token', async () => {
    createMock.createSessionFromInviteToken.mockResolvedValue({
      ok: false,
      status: 410,
      code: 'INVITE_EXPIRED',
      message: 'This invitation has expired',
    });
    const res = await POST(req({ inviteToken: 'tok-1' }));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITE_EXPIRED');
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('400s on a missing inviteToken', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });

  it('400s on an empty inviteToken', async () => {
    const res = await POST(req({ inviteToken: '' }));
    expect(res.status).toBe(400);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });
});
