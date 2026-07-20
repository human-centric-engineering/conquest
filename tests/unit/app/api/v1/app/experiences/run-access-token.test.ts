/**
 * Run access token (P15.3) — the credential guarding the `/x/<publicRef>` surface.
 *
 * These tests exist because this token authorises reading whole respondent transcripts, which can
 * contain raw safeguarding disclosures. The signature and expiry checks are the only thing between
 * a guessable eight-character ref and that data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_SECRET: 'test-secret-value-for-hmac' } }));

import {
  RUN_TOKEN_EXPIRY_HOURS,
  mintRunToken,
  runCookieHeader,
  runCookieName,
  verifyRunToken,
} from '@/app/api/v1/app/experiences/_lib/run-access-token';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const RUN_ID = 'run_abc123';
const NOW = new Date('2026-07-20T12:00:00.000Z');

describe('mintRunToken / verifyRunToken', () => {
  it('round-trips the run id', () => {
    const { token } = mintRunToken(RUN_ID, RUN_TOKEN_EXPIRY_HOURS, NOW);
    const result = verifyRunToken(token, NOW);
    expect(result).toEqual({ ok: true, runId: RUN_ID });
  });

  it('reports the expiry it stamped', () => {
    const { expiresAt } = mintRunToken(RUN_ID, 24, NOW);
    expect(expiresAt.toISOString()).toBe('2026-07-21T12:00:00.000Z');
  });

  it('rejects a token whose payload was edited (signature no longer matches)', () => {
    const { token } = mintRunToken(RUN_ID, 24, NOW);
    const [, signature] = token.split('.');
    // Re-encode a DIFFERENT run id against the original signature — the exact forgery that would
    // let a holder of one journey's credential read another's.
    const forgedPayload = Buffer.from(
      JSON.stringify({ runId: 'run_someone_else', expiresAt: '2026-07-21T12:00:00.000Z' }),
      'utf8'
    ).toString('base64url');
    const result = verifyRunToken(`${forgedPayload}.${signature}`, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', () => {
    const { token } = mintRunToken(RUN_ID, 24, NOW);
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect(verifyRunToken(token, later)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a token right up to its expiry boundary', () => {
    const { token, expiresAt } = mintRunToken(RUN_ID, 24, NOW);
    // One millisecond before expiry is still valid; the check is `expiresAt < now`.
    const justBefore = new Date(expiresAt.getTime() - 1);
    expect(verifyRunToken(token, justBefore)).toEqual({ ok: true, runId: RUN_ID });
  });

  it.each([
    ['no separator', 'not-a-token'],
    ['empty', ''],
    ['payload only', 'eyJhIjoxfQ'],
  ])('rejects a malformed token (%s) without throwing', (_label, bad) => {
    expect(() => verifyRunToken(bad, NOW)).not.toThrow();
    expect(verifyRunToken(bad, NOW).ok).toBe(false);
  });

  /**
   * The domain-separation guard. A session token and a run token are structurally near-identical
   * JSON signed with the same secret; without the domain prefix in the HMAC, one could be replayed
   * against the other's verifier if the field names ever converged.
   */
  it('does not accept a session token as a run token', () => {
    const { token } = mintSessionToken(RUN_ID, 24, NOW);
    expect(verifyRunToken(token, NOW).ok).toBe(false);
  });
});

describe('runCookieName', () => {
  it('namespaces per run so concurrent journeys do not evict each other', () => {
    expect(runCookieName('7F3K9M2P')).toBe('cq_run_7F3K9M2P');
    expect(runCookieName('AAAA1111')).not.toBe(runCookieName('7F3K9M2P'));
  });
});

describe('runCookieHeader', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.stubEnv('NODE_ENV', ORIGINAL_ENV ?? 'test');
    vi.unstubAllEnvs();
  });

  it('is HttpOnly and SameSite=Lax — the two properties the design depends on', () => {
    const header = runCookieHeader('7F3K9M2P', 'tok');
    // HttpOnly is what keeps the credential out of reach of injected script; without it the
    // cookie is no better than the localStorage token it replaced.
    expect(header).toContain('HttpOnly');
    // Lax rather than Strict so a respondent arriving from an email or chat app still carries it
    // on that first cross-site navigation.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('carries a Max-Age matching the token lifetime', () => {
    expect(runCookieHeader('7F3K9M2P', 'tok')).toContain(
      `Max-Age=${RUN_TOKEN_EXPIRY_HOURS * 60 * 60}`
    );
  });

  it('omits Secure outside production so local HTTP development works', () => {
    expect(runCookieHeader('7F3K9M2P', 'tok')).not.toContain('Secure');
  });

  it('sets Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(runCookieHeader('7F3K9M2P', 'tok')).toContain('Secure');
  });
});
