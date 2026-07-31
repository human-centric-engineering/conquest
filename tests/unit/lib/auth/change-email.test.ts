/**
 * Email-change token discrimination (#489)
 *
 * `parseEmailChangeToken` is what lets the two SHARED better-auth callbacks
 * (`sendVerificationEmail`, `afterEmailVerification`) tell an email change from
 * a signup verification. Getting that wrong is not cosmetic in either direction:
 *
 *   - a change misread as a signup → the invitation skip strands the change with
 *     no email sent, and the user is greeted with a "Welcome!" email
 *   - a signup misread as a change → no welcome email, and the new user's
 *     sessions are revoked for no reason
 *
 * So these cases pin the discriminator itself, not just the happy path.
 *
 * @see lib/auth/change-email.ts · lib/auth/config.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyJWT = vi.fn();

vi.mock('better-auth/crypto', () => ({
  verifyJWT: (...args: unknown[]) => verifyJWT(...args) as unknown,
}));

vi.mock('@/lib/env', () => ({
  env: { BETTER_AUTH_SECRET: 'test-secret' },
}));

import { parseEmailChangeToken, getVerificationTokenFromRequest } from '@/lib/auth/change-email';

describe('parseEmailChangeToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies an email-change token and returns both addresses', async () => {
    // `updateTo` is the discriminator: better-auth only sets it on a change.
    // `email` is the address being moved away FROM, which the old-address
    // notification and the session revocation both need and which neither
    // callback otherwise supplies.
    verifyJWT.mockResolvedValue({
      email: 'old@example.com',
      updateTo: 'new@example.com',
      requestType: 'change-email-verification',
    });

    const result = await parseEmailChangeToken('a-token');

    expect(result).toEqual({
      previousEmail: 'old@example.com',
      newEmail: 'new@example.com',
    });
  });

  it('returns null for a signup token, which carries no updateTo', async () => {
    verifyJWT.mockResolvedValue({ email: 'someone@example.com' });

    expect(await parseEmailChangeToken('a-token')).toBeNull();
  });

  it('returns null when updateTo is present but requestType is not the verified change type', async () => {
    // better-auth's own verify-email handler switches on `requestType` across
    // more branches than the two this module currently reaches through. Gating
    // on `updateTo` alone would treat any future token shape carrying it under
    // a different requestType as an ordinary email change; requiring the exact
    // type is the safer failure if that ever happens.
    verifyJWT.mockResolvedValue({
      email: 'old@example.com',
      updateTo: 'new@example.com',
      requestType: 'change-email-confirmation',
    });

    expect(await parseEmailChangeToken('a-token')).toBeNull();
  });

  it('returns null when there is no token at all', async () => {
    // `afterEmailVerification` can be reached without a Request, so the
    // undefined case is real rather than defensive padding.
    expect(await parseEmailChangeToken(undefined)).toBeNull();
    expect(verifyJWT).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the token will not verify', async () => {
    // Falling back to "this is a signup" is the safe direction: the cost is a
    // redundant welcome email, versus skipping one and revoking sessions.
    verifyJWT.mockRejectedValue(new Error('bad signature'));

    expect(await parseEmailChangeToken('tampered')).toBeNull();
  });

  it('returns null when the payload is not the expected shape', async () => {
    // verifyJWT resolves `null` for a token it cannot decode.
    verifyJWT.mockResolvedValue(null);

    expect(await parseEmailChangeToken('nonsense')).toBeNull();
  });

  it('verifies the signature rather than blindly decoding', async () => {
    verifyJWT.mockResolvedValue({ email: 'old@example.com', updateTo: 'new@example.com' });

    await parseEmailChangeToken('a-token');

    expect(verifyJWT).toHaveBeenCalledWith('a-token', 'test-secret');
  });
});

describe('getVerificationTokenFromRequest', () => {
  it('pulls the token out of the verification URL', () => {
    const request = new Request('https://app.example.com/api/auth/verify-email?token=abc123');

    expect(getVerificationTokenFromRequest(request)).toBe('abc123');
  });

  it('returns undefined when there is no token parameter', () => {
    const request = new Request('https://app.example.com/api/auth/verify-email');

    expect(getVerificationTokenFromRequest(request)).toBeUndefined();
  });

  it('returns undefined when there is no request', () => {
    // better-auth types `request` as optional — it is absent when the API is
    // driven server-side without one.
    expect(getVerificationTokenFromRequest(undefined)).toBeUndefined();
  });
});
