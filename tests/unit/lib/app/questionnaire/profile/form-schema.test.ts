/**
 * Unit test: the client profile-capture form schema (F-capture).
 *
 * `buildProfileFormSchema` is the deterministic-format layer the in-flow capture gate uses for instant
 * per-field feedback (the server re-validates authoritatively). Covers per-type rules and the
 * required/optional distinction — including the empty-string-allowed optional path.
 */

import { describe, it, expect } from 'vitest';

import { buildProfileFormSchema } from '@/lib/app/questionnaire/profile/form-schema';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

function field(over: Partial<ProfileFieldConfig> & { key: string }): ProfileFieldConfig {
  return { label: over.key, type: 'text', required: true, validation: 'deterministic', ...over };
}

describe('buildProfileFormSchema', () => {
  it('requires a non-empty value for a required text field', () => {
    const schema = buildProfileFormSchema([field({ key: 'name', type: 'text', required: true })]);
    expect(schema.safeParse({ name: 'Ada' }).success).toBe(true);
    expect(schema.safeParse({ name: '' }).success).toBe(false);
  });

  it('validates email shape', () => {
    const schema = buildProfileFormSchema([field({ key: 'email', type: 'email', required: true })]);
    expect(schema.safeParse({ email: 'ada@example.com' }).success).toBe(true);
    expect(schema.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('requires a numeric string for a number field', () => {
    const schema = buildProfileFormSchema([field({ key: 'size', type: 'number', required: true })]);
    expect(schema.safeParse({ size: '42' }).success).toBe(true);
    expect(schema.safeParse({ size: '-3.5' }).success).toBe(true);
    expect(schema.safeParse({ size: 'lots' }).success).toBe(false);
  });

  it('requires a chosen value for a select field', () => {
    const schema = buildProfileFormSchema([field({ key: 'tier', type: 'select', required: true })]);
    expect(schema.safeParse({ tier: 'pro' }).success).toBe(true);
    expect(schema.safeParse({ tier: '' }).success).toBe(false);
  });

  it('lets an OPTIONAL field be an empty string (rendered blank, stripped before submit)', () => {
    const schema = buildProfileFormSchema([
      field({ key: 'org', type: 'text', required: false }),
      field({ key: 'email', type: 'email', required: false }),
    ]);
    // Empty is accepted for optional fields...
    expect(schema.safeParse({ org: '', email: '' }).success).toBe(true);
    // ...but a NON-empty optional value must still satisfy its type.
    expect(schema.safeParse({ org: 'Acme', email: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ org: 'Acme', email: 'ada@example.com' }).success).toBe(true);
  });
});
