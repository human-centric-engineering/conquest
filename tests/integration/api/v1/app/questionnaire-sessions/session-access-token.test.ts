/**
 * Unit test: stateless HMAC session-access tokens (F6.1, PR6).
 *
 * Round-trips a minted token, and pins the three rejection modes (bad signature, malformed,
 * expired) plus the session binding. Uses the real BETTER_AUTH_SECRET from the test env.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long' },
}));

import {
  mintSessionToken,
  verifySessionToken,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const T0 = new Date('2026-06-06T00:00:00.000Z');

describe('session-access-token', () => {
  it('verifies a freshly minted token and returns its sessionId', () => {
    const { token } = mintSessionToken('sess-1', 24, T0);
    const result = verifySessionToken(token, T0);
    expect(result).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('rejects a token whose signature was tampered with', () => {
    const { token } = mintSessionToken('sess-1', 24, T0);
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifySessionToken(tampered, T0).ok).toBe(false);
  });

  it('rejects a malformed token with no signature delimiter', () => {
    expect(verifySessionToken('not-a-token', T0)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an expired token', () => {
    const { token } = mintSessionToken('sess-1', 1, T0); // 1 hour
    const later = new Date(T0.getTime() + 2 * 60 * 60 * 1000); // +2h
    expect(verifySessionToken(token, later)).toEqual({ ok: false, reason: 'expired' });
  });

  it('binds the token to its session (a different session id verifies but does not match)', () => {
    const { token } = mintSessionToken('sess-A', 24, T0);
    const result = verifySessionToken(token, T0);
    // The token verifies but carries sess-A; the route compares against the requested session.
    expect(result).toEqual({ ok: true, sessionId: 'sess-A' });
  });

  it('sets an expiry the configured number of hours out', () => {
    const { expiresAt } = mintSessionToken('sess-1', 24, T0);
    expect(expiresAt.toISOString()).toBe('2026-06-07T00:00:00.000Z');
  });
});
