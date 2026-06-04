import { describe, it, expect } from 'vitest';

import {
  mintInvitationToken,
  hashInvitationToken,
  INVITATION_TOKEN_EXPIRY_DAYS,
} from '@/lib/app/questionnaire/invitations/token';

describe('hashInvitationToken', () => {
  it('is deterministic and produces 64 hex chars (SHA-256)', () => {
    const h1 = hashInvitationToken('abc');
    const h2 = hashInvitationToken('abc');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(hashInvitationToken('abc')).not.toBe(hashInvitationToken('abd'));
  });
});

describe('mintInvitationToken', () => {
  it('returns a 64-hex plaintext token whose hash is NOT the token', () => {
    const { token, tokenHash } = mintInvitationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).not.toBe(token); // hash at rest ≠ plaintext
  });

  it('sets expiry INVITATION_TOKEN_EXPIRY_DAYS from the provided now', () => {
    const now = new Date('2026-06-04T00:00:00.000Z');
    const { expiresAt } = mintInvitationToken(now);
    const expected = new Date(now.getTime() + INVITATION_TOKEN_EXPIRY_DAYS * 86400_000);
    expect(expiresAt.toISOString()).toBe(expected.toISOString());
  });

  it('mints a fresh, unique token each call', () => {
    const a = mintInvitationToken();
    const b = mintInvitationToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
