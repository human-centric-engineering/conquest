/**
 * Integration test: admin "Preview as respondent" session-create route.
 *
 * The create seam, rate limiter, and token minter are mocked, plus better-auth. Pins the
 * admin-only preview surface: the admin-auth gate
 * (401/403), the per-admin sub-cap, dispatch to createPreviewSession, the typed-failure → HTTP
 * mapping, and that a success returns the minted access token. The anonymous-mode bypass lives
 * in createPreviewSession (unit-tested in create-session.test.ts); here we pin that the route
 * is admin-gated, unlike the public /anonymous route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const rateMock = vi.hoisted(() => ({ sessionStartLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const createMock = vi.hoisted(() => ({ createPreviewSession: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => createMock);

const tokenMock = vi.hoisted(() => ({ mintSessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/preview/route';
import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/preview';
function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const SESSION = { id: 'sess-preview', status: 'active', versionId: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  rateMock.sessionStartLimiter.check.mockReturnValue({ success: true });
  createMock.createPreviewSession.mockResolvedValue({
    ok: true,
    session: SESSION,
    resumed: false,
  });
  tokenMock.mintSessionToken.mockReturnValue({
    token: 'tok.sig',
    expiresAt: new Date('2026-06-07T00:00:00.000Z'),
  });
});

describe('preview create', () => {
  it('401s an unauthenticated caller (this surface is admin-only, unlike /anonymous)', async () => {
    setAuth(null);
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(401);
    expect(createMock.createPreviewSession).not.toHaveBeenCalled();
  });

  it('403s a non-admin authenticated caller', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(403);
    expect(createMock.createPreviewSession).not.toHaveBeenCalled();
  });

  it('429s when the per-admin sub-cap is exceeded', async () => {
    rateMock.sessionStartLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(429);
  });

  it('creates a preview session and returns the minted access token (201)', async () => {
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(201);
    expect(createMock.createPreviewSession).toHaveBeenCalledWith('v1');
    expect(tokenMock.mintSessionToken).toHaveBeenCalledWith('sess-preview');
    const body = await res.json();
    expect(body.data).toMatchObject({ session: SESSION, accessToken: 'tok.sig' });
  });

  it('keys the sub-cap on the admin user id', async () => {
    await POST(req({ versionId: 'v1' }));
    expect(rateMock.sessionStartLimiter.check).toHaveBeenCalledWith(
      `preview:${mockAdminUser().user.id}`
    );
  });

  it('maps a 404 NOT_FOUND (unknown/unlaunched version) to 404', async () => {
    createMock.createPreviewSession.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'Questionnaire not found',
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('400s on a missing versionId', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});
