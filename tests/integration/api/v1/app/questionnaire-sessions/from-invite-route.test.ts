/**
 * Integration test: frictionless invite session-create route (invitations Phase B).
 *
 * The create seam, rate limiter, and token minter are mocked. Pins the public surface: the
 * live-sessions flag gate (outer wrapper) AND the frictionless-invites sub-flag (inner 404),
 * the IP-keyed sub-cap, dispatch to createSessionFromInviteToken, the typed-failure → HTTP
 * mapping, and that a success returns the minted access token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));

const rateMock = vi.hoisted(() => ({ sessionStartLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const createMock = vi.hoisted(() => ({ createSessionFromInviteToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => createMock);

const tokenMock = vi.hoisted(() => ({ mintSessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/from-invite/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
} from '@/lib/app/questionnaire/constants';

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
  // All three gates on (master + live-sessions + frictionless) → happy path.
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
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
  it('404s when the live-sessions flag is off (outer wrapper, no create)', async () => {
    // Master on, live-sessions off → withLiveSessionsEnabled blocks before the handler runs.
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag !== APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG)
    );
    const res = await POST(req({ inviteToken: 'tok-1' }), undefined);
    expect(res.status).toBe(404);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });

  it('404s when the frictionless-invites sub-flag is off (falls back to accept flow)', async () => {
    // Live-sessions on, frictionless off → inner 404, no create, no rate-limit consumed.
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(
        flag === APP_QUESTIONNAIRES_FLAG || flag === APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG
      )
    );
    const res = await POST(req({ inviteToken: 'tok-1' }), undefined);
    expect(res.status).toBe(404);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });

  it('429s when the IP sub-cap is exceeded', async () => {
    rateMock.sessionStartLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req({ inviteToken: 'tok-1' }), undefined);
    expect(res.status).toBe(429);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });

  it('keys the IP sub-cap with the invite: prefix', async () => {
    await POST(req({ inviteToken: 'tok-1' }), undefined);
    expect(rateMock.sessionStartLimiter.check).toHaveBeenCalledWith('invite:203.0.113.7');
  });

  it('creates a session from the token and returns the minted access token (201)', async () => {
    const res = await POST(req({ inviteToken: 'tok-1' }), undefined);
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
    const res = await POST(req({ inviteToken: 'tok-1' }), undefined);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITE_EXPIRED');
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('400s on a missing inviteToken', async () => {
    const res = await POST(req({}), undefined);
    expect(res.status).toBe(400);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });

  it('400s on an empty inviteToken', async () => {
    const res = await POST(req({ inviteToken: '' }), undefined);
    expect(res.status).toBe(400);
    expect(createMock.createSessionFromInviteToken).not.toHaveBeenCalled();
  });
});
