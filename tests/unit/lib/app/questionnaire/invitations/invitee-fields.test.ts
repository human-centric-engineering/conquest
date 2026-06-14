import { describe, expect, it } from 'vitest';

import {
  parseInviteeFields,
  shownInviteeFields,
  validateInviteeProfile,
} from '@/lib/app/questionnaire/invitations/invitee-fields';
import { INVITEE_FIELD_KEYS } from '@/lib/app/questionnaire/types';

describe('parseInviteeFields', () => {
  it('returns the full closed set in canonical order, even from an empty config', () => {
    const parsed = parseInviteeFields([]);
    expect(parsed.map((f) => f.key)).toEqual([...INVITEE_FIELD_KEYS]);
  });

  it('forces email shown + required regardless of what is stored', () => {
    const parsed = parseInviteeFields([{ key: 'email', shown: false, required: false }]);
    const email = parsed.find((f) => f.key === 'email')!;
    expect(email).toEqual({ key: 'email', shown: true, required: true });
  });

  it('honours stored shown/required for non-email fields and fills missing from defaults', () => {
    const parsed = parseInviteeFields([{ key: 'jobTitle', shown: true, required: true }]);
    expect(parsed.find((f) => f.key === 'jobTitle')).toEqual({
      key: 'jobTitle',
      shown: true,
      required: true,
    });
    // A key absent from the stored config falls back to its default (organisation: hidden).
    expect(parsed.find((f) => f.key === 'organisation')).toEqual({
      key: 'organisation',
      shown: false,
      required: false,
    });
  });

  it('drops malformed/unknown entries (degrades to defaults)', () => {
    const parsed = parseInviteeFields([{ key: 'nope', shown: true, required: true }]);
    expect(parsed.map((f) => f.key)).toEqual([...INVITEE_FIELD_KEYS]);
  });
});

describe('shownInviteeFields', () => {
  it('returns only shown fields in order', () => {
    const shown = shownInviteeFields(parseInviteeFields([]));
    expect(shown.map((f) => f.key)).toEqual(['firstName', 'surname', 'email']);
  });
});

describe('validateInviteeProfile', () => {
  const fields = parseInviteeFields([
    { key: 'firstName', shown: true, required: true },
    { key: 'jobTitle', shown: true, required: false },
    { key: 'organisation', shown: false, required: false },
  ]);

  it('accepts a valid profile, lowercasing the email', () => {
    const result = validateInviteeProfile(fields, {
      firstName: 'Ada',
      email: 'Ada@Example.com',
      jobTitle: 'Engineer',
    });
    expect(result).toEqual({
      ok: true,
      values: { firstName: 'Ada', email: 'ada@example.com', jobTitle: 'Engineer' },
    });
  });

  it('rejects a missing required field (email always required)', () => {
    const result = validateInviteeProfile(fields, { firstName: 'Ada' });
    expect(result.ok).toBe(false);
  });

  it('rejects a blank required non-email field', () => {
    const result = validateInviteeProfile(fields, { firstName: '  ', email: 'a@b.com' });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid email', () => {
    const result = validateInviteeProfile(fields, { firstName: 'Ada', email: 'not-an-email' });
    expect(result.ok).toBe(false);
  });

  it('omits an optional field when blank, and rejects a hidden field', () => {
    const ok = validateInviteeProfile(fields, { firstName: 'Ada', email: 'a@b.com', jobTitle: '' });
    expect(ok).toEqual({ ok: true, values: { firstName: 'Ada', email: 'a@b.com' } });

    // organisation is hidden → not an accepted key.
    const rejected = validateInviteeProfile(fields, {
      firstName: 'Ada',
      email: 'a@b.com',
      organisation: 'Acme',
    });
    expect(rejected.ok).toBe(false);
  });
});
