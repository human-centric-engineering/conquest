/**
 * Integration test: turn-route access resolution (F6.1, PR6).
 *
 * Pins both branches: an authenticated owner (matching session / 401 / 403) and the no-login
 * anonymous token path (valid / missing / forged / wrong-session). `auth.api.getSession` and
 * `next/headers` are mocked; the anonymous path uses a real minted token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/env', () => ({
  env: { BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long' },
}));

import {
  resolveTurnAccess,
  SESSION_TOKEN_HEADER,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { auth } from '@/lib/auth/config';
import { resolveApiKey } from '@/lib/auth/api-keys';

type Mock = ReturnType<typeof vi.fn>;

function req(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}
/** A better-auth-shaped session (the full AuthSession contract, not a bare `{user:{id}}`). */
function authSession(userId: string) {
  const ts = new Date('2026-06-06T00:00:00.000Z');
  return {
    session: { id: 'as_test', userId, token: 't', expiresAt: ts, createdAt: ts, updatedAt: ts },
    user: {
      id: userId,
      name: 'Test',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role: 'USER',
      createdAt: ts,
      updatedAt: ts,
    },
  };
}
function setSession(userId: string | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(userId ? authSession(userId) : null);
}
/** A resolveApiKey result (its `session` is a full AuthSession; plus scopes + rateLimitRpm). */
function apiKeyFor(userId: string) {
  return { session: authSession(userId), scopes: ['chat'], rateLimitRpm: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveApiKey as unknown as Mock).mockResolvedValue(null); // no API key by default
});

describe('authenticated owner', () => {
  it('grants access when the logged-in user owns the session', async () => {
    setSession('user-1');
    const access = await resolveTurnAccess(req(), { id: 'sess-1', respondentUserId: 'user-1' });
    expect(access).toEqual({ ok: true, userId: 'user-1', rateKey: 'user-1', anonymous: false });
  });

  it('401s when there is no logged-in session', async () => {
    setSession(null);
    const access = await resolveTurnAccess(req(), { id: 'sess-1', respondentUserId: 'user-1' });
    expect(access).toMatchObject({ ok: false, status: 401 });
  });

  it('grants access via a valid API key (Bearer sk_...) without a cookie session', async () => {
    setSession(null); // no cookie session
    (resolveApiKey as unknown as Mock).mockResolvedValue(apiKeyFor('user-1'));
    const access = await resolveTurnAccess(req(), { id: 'sess-1', respondentUserId: 'user-1' });
    expect(access).toMatchObject({
      ok: true,
      userId: 'user-1',
      rateKey: 'user-1',
      anonymous: false,
    });
    // The API key short-circuits the cookie-session lookup.
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('403s when a valid API key belongs to a different user than the session owner', async () => {
    setSession(null);
    (resolveApiKey as unknown as Mock).mockResolvedValue(apiKeyFor('intruder'));
    const access = await resolveTurnAccess(req(), { id: 'sess-1', respondentUserId: 'user-1' });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN' });
  });

  it('403s when a different user is logged in', async () => {
    setSession('intruder');
    const access = await resolveTurnAccess(req(), { id: 'sess-1', respondentUserId: 'user-1' });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN' });
  });
});

describe('anonymous token', () => {
  const anon = { id: 'sess-anon', respondentUserId: null };

  it('grants access with a valid token bound to the session', async () => {
    const { token } = mintSessionToken('sess-anon');
    const access = await resolveTurnAccess(req({ [SESSION_TOKEN_HEADER]: token }), anon);
    expect(access).toMatchObject({
      ok: true,
      anonymous: true,
      userId: 'anon:sess-anon',
      // The rate-limit key is the IP+session compound — the field rate limiting depends on.
      rateKey: expect.stringContaining('sess-anon'),
    });
    // never consults the auth session for the anonymous path
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when the token header is missing', async () => {
    const access = await resolveTurnAccess(req(), anon);
    expect(access).toMatchObject({ ok: false, status: 401, code: 'SESSION_TOKEN_REQUIRED' });
  });

  it('401s when the token is forged', async () => {
    const access = await resolveTurnAccess(req({ [SESSION_TOKEN_HEADER]: 'garbage.sig' }), anon);
    expect(access).toMatchObject({ ok: false, status: 401, code: 'SESSION_TOKEN_INVALID' });
  });

  it('401s when the token is for a different session', async () => {
    const { token } = mintSessionToken('some-other-session');
    const access = await resolveTurnAccess(req({ [SESSION_TOKEN_HEADER]: token }), anon);
    expect(access).toMatchObject({ ok: false, status: 401, code: 'SESSION_TOKEN_INVALID' });
  });
});
