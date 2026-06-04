import { describe, it, expect } from 'vitest';

import {
  createInvitationsSchema,
  acceptInvitationSchema,
  MAX_INVITE_RECIPIENTS,
} from '@/lib/app/questionnaire/invitations/schemas';

describe('createInvitationsSchema', () => {
  it('accepts a single recipient and normalises the email', () => {
    const parsed = createInvitationsSchema.parse({
      recipients: [{ email: '  Alice@Example.COM ', name: '  Alice  ' }],
    });
    expect(parsed.recipients[0].email).toBe('alice@example.com');
    expect(parsed.recipients[0].name).toBe('Alice');
  });

  it('coerces an empty name to undefined', () => {
    const parsed = createInvitationsSchema.parse({
      recipients: [{ email: 'a@example.com', name: '   ' }],
    });
    expect(parsed.recipients[0].name).toBeUndefined();
  });

  it('accepts a bulk batch of distinct emails', () => {
    const parsed = createInvitationsSchema.parse({
      recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }],
    });
    expect(parsed.recipients).toHaveLength(3);
  });

  it('rejects an empty recipients array', () => {
    expect(createInvitationsSchema.safeParse({ recipients: [] }).success).toBe(false);
  });

  it('rejects more than MAX_INVITE_RECIPIENTS', () => {
    const recipients = Array.from({ length: MAX_INVITE_RECIPIENTS + 1 }, (_, i) => ({
      email: `user${i}@x.com`,
    }));
    expect(createInvitationsSchema.safeParse({ recipients }).success).toBe(false);
  });

  it('rejects duplicate emails within the batch (case-insensitively)', () => {
    const result = createInvitationsSchema.safeParse({
      recipients: [{ email: 'a@x.com' }, { email: 'A@X.com' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('Duplicate'))).toBe(true);
    }
  });

  it('rejects a malformed email', () => {
    expect(
      createInvitationsSchema.safeParse({ recipients: [{ email: 'not-an-email' }] }).success
    ).toBe(false);
  });
});

describe('acceptInvitationSchema', () => {
  it('accepts a token + 8+ char password', () => {
    expect(acceptInvitationSchema.safeParse({ token: 'abc', password: 'longenough' }).success).toBe(
      true
    );
  });

  it('rejects a short password', () => {
    expect(acceptInvitationSchema.safeParse({ token: 'abc', password: 'short' }).success).toBe(
      false
    );
  });

  it('rejects a missing token', () => {
    expect(acceptInvitationSchema.safeParse({ token: '', password: 'longenough' }).success).toBe(
      false
    );
  });
});
