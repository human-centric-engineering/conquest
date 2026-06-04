/**
 * Invitation token minting (F3.2). Pure — `crypto` only, no Prisma / Next.
 *
 * Same recipe as the platform's `lib/utils/invitation-token.ts`: a 32-byte
 * cryptographically-random token, SHA-256-hashed at rest. The DB stores only the
 * hash (`AppQuestionnaireInvitation.tokenHash`); the plaintext lives solely in the
 * emailed URL. Lookups hash the URL token and match the stored hash, so a database
 * read never yields a usable token.
 */

import { randomBytes, createHash } from 'crypto';

const TOKEN_BYTE_LENGTH = 32; // 32 bytes → 64 hex chars
export const INVITATION_TOKEN_EXPIRY_DAYS = 7;

/** SHA-256 of a plaintext token, as lowercase hex. The value stored in `tokenHash`. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MintedInvitationToken {
  /** Plaintext token — goes in the email URL only, never persisted. */
  token: string;
  /** SHA-256 of the token — persisted to `tokenHash`. */
  tokenHash: string;
  /** Expiry, `INVITATION_TOKEN_EXPIRY_DAYS` from `now`. */
  expiresAt: Date;
}

/** Mint a fresh token + its hash + expiry. `now` is injectable for deterministic tests. */
export function mintInvitationToken(now: Date = new Date()): MintedInvitationToken {
  const token = randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
  const expiresAt = new Date(now.getTime() + INVITATION_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashInvitationToken(token), expiresAt };
}
