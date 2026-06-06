/**
 * Stateless HMAC-signed session-access tokens for no-login anonymous sessions (F6.1, PR6).
 *
 * An anonymous respondent has no account, so the session can't be keyed on a user. Instead
 * the create endpoint mints a signed token bound to the session id; each turn presents it
 * (the `X-Session-Token` header) and the route verifies it cryptographically. Modelled on
 * `lib/orchestration/approval-tokens.ts` — NOT a bare session id (Prisma `cuid()` is not
 * cryptographically random, so it must not be a bearer credential on its own).
 *
 * Token format: `<base64url-payload>.<base64url-signature>`
 *   payload   = JSON { sessionId, expiresAt }
 *   signature = HMAC-SHA256(BETTER_AUTH_SECRET, payload-bytes)
 *
 * No DB storage or migration — verification is purely cryptographic. Tokens can't be
 * revoked individually; anonymous sessions are short-lived demo/ad-hoc runs, and abandoning
 * one is harmless (it holds no PII by definition).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { env } from '@/lib/env';

/** Anonymous session-token lifetime. Long enough to finish a sitting, short enough to age out. */
export const SESSION_TOKEN_EXPIRY_HOURS = 24;

const payloadSchema = z.object({
  sessionId: z.string().min(1),
  expiresAt: z.string().min(1),
});
type SessionTokenPayload = z.infer<typeof payloadSchema>;

function sign(payloadJson: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(payloadJson, 'utf8')
    .digest('base64url');
}

/** Mint a signed access token for an anonymous session. */
export function mintSessionToken(
  sessionId: string,
  expiresInHours: number = SESSION_TOKEN_EXPIRY_HOURS,
  now: Date = new Date()
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);
  const payloadJson = JSON.stringify({ sessionId, expiresAt: expiresAt.toISOString() });
  const encoded = Buffer.from(payloadJson, 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(payloadJson)}`, expiresAt };
}

/** The result of verifying a session token. */
export type SessionTokenResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a session-access token: constant-time signature check, then expiry. Returns the
 * bound `sessionId` on success. Never throws — a malformed/forged/expired token is a typed
 * failure the route maps to 401.
 */
export function verifySessionToken(token: string, now: Date = new Date()): SessionTokenResult {
  const dot = token.indexOf('.');
  if (dot === -1) return { ok: false, reason: 'malformed' };

  const encodedPayload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedSig = sign(payloadJson);
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionTokenPayload;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(payloadJson));
    if (!parsed.success) return { ok: false, reason: 'malformed' };
    payload = parsed.data;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expiresAt = new Date(payload.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, sessionId: payload.sessionId };
}
