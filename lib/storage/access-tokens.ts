/**
 * Stateless HMAC-signed storage access tokens.
 *
 * Grants time-limited read access to **one** storage key without a session.
 * Used by `LocalProvider.getSignedUrl()` to give private local objects the
 * same shape of read path S3 gets from presigned URLs.
 *
 * Token format: `<base64url-payload>.<base64url-signature>`
 *   payload = JSON { key, expiresAt }
 *   signature = HMAC-SHA256(BETTER_AUTH_SECRET, payload-bytes)
 *
 * No database storage or migration required — verification is purely
 * cryptographic, mirroring `lib/orchestration/approval-tokens.ts`.
 *
 * **The token is scoped to a single key, and the read route must check it
 * against the key actually requested.** That binding is the entire access
 * control model here: storage keys carry no ownership
 * (`agent-uploads/{agentId}/{uuid}` names no user), so there is nothing else
 * to authorise against. A token that verified but was not compared to the
 * requested key would be a universal read grant.
 *
 * @see app/api/v1/storage/[...key]/route.ts — the only consumer
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { env } from '@/lib/env';

/** Default token lifetime when the caller doesn't specify one. */
const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * Upper bound on a token's life. Matches the `signedUrlTtlSeconds` ceiling in
 * the `upload_to_storage` binding schema — a longer-lived bearer URL for a
 * private file is a link that outlives the reason it was issued.
 */
export const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

const tokenPayloadSchema = z.object({
  key: z.string().min(1),
  expiresAt: z.string().min(1),
});

type TokenPayload = z.infer<typeof tokenPayloadSchema>;

function getSecret(): string {
  return env.BETTER_AUTH_SECRET;
}

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function sign(payloadJson: string): string {
  return createHmac('sha256', getSecret()).update(payloadJson, 'utf8').digest('base64url');
}

/**
 * Generate a signed read token for a single storage key.
 *
 * @param key - The storage key this token grants access to, and only this key
 * @param expiresInSeconds - Lifetime, clamped to {@link MAX_EXPIRY_SECONDS}
 */
export function generateStorageAccessToken(
  key: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS
): { token: string; expiresAt: Date } {
  if (!key) {
    throw new Error('Storage access token requires a key');
  }

  const ttl = Math.min(Math.max(Math.floor(expiresInSeconds), 1), MAX_EXPIRY_SECONDS);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const payload: TokenPayload = { key, expiresAt: expiresAt.toISOString() };

  const payloadJson = JSON.stringify(payload);

  return {
    token: `${base64UrlEncode(payloadJson)}.${sign(payloadJson)}`,
    expiresAt,
  };
}

/**
 * Verify a signed storage token. Returns the decoded payload on success, or
 * throws on tampered / expired / malformed tokens.
 *
 * Verifying tells you the token is authentic — **not** that it grants access
 * to the object being requested. The caller must compare `payload.key`
 * against the requested key.
 */
export function verifyStorageAccessToken(token: string): TokenPayload {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('Invalid storage token format');
  }

  const encodedPayload = token.slice(0, dotIndex);
  const providedSignature = token.slice(dotIndex + 1);

  let payloadJson: string;
  try {
    payloadJson = base64UrlDecode(encodedPayload);
  } catch {
    throw new Error('Invalid storage token encoding');
  }

  const expectedSignature = sign(payloadJson);

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(providedSignature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid storage token signature');
  }

  let payload: TokenPayload;
  try {
    const raw: unknown = JSON.parse(payloadJson);
    const parsed = tokenPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Incomplete storage token payload');
    }
    payload = parsed.data;
  } catch (err) {
    if (err instanceof Error && err.message === 'Incomplete storage token payload') throw err;
    throw new Error('Invalid storage token payload');
  }

  const expiresAt = new Date(payload.expiresAt);
  if (isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new Error('Storage token has expired');
  }

  return payload;
}

/**
 * Build the signed read URL for a storage key.
 *
 * Relative by default — the route lives in this app, and a relative URL is
 * correct behind any hostname the deployment answers on. Pass `baseUrl` when
 * the URL leaves the app (an email, a webhook payload).
 */
export function buildStorageAccessUrl(
  key: string,
  expiresInSeconds?: number,
  baseUrl?: string
): { url: string; expiresAt: Date } {
  const { token, expiresAt } = generateStorageAccessToken(key, expiresInSeconds);

  // Each segment is encoded separately so the `/` separators survive.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path = `/api/v1/storage/${encodedKey}?token=${encodeURIComponent(token)}`;

  return {
    url: baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path,
    expiresAt,
  };
}
