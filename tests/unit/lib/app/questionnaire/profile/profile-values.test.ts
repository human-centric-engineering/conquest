/**
 * Unit test: respondent profile-value validation (F8.3).
 *
 * The pure validator that guards both the client form and the server capture seam:
 * unknown keys are rejected, required fields enforced, types coerced/checked, and empty
 * submissions treated as "not supplied".
 */

import { describe, it, expect } from 'vitest';

import {
  validateProfileValues,
  parseProfileFields,
  asProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

const FIELDS: ProfileFieldConfig[] = [
  { key: 'team', label: 'Team', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: false },
  { key: 'size', label: 'Team size', type: 'number', required: false },
  { key: 'tier', label: 'Tier', type: 'select', required: false, options: ['free', 'pro'] },
];

describe('validateProfileValues', () => {
  it('accepts a valid submission and returns the cleaned values', () => {
    const result = validateProfileValues(FIELDS, {
      team: 'Analytics',
      email: 'ada@example.com',
      size: '12',
      tier: 'pro',
    });
    expect(result).toEqual({
      ok: true,
      values: { team: 'Analytics', email: 'ada@example.com', size: 12, tier: 'pro' },
    });
  });

  it('rejects unknown keys (no PII smuggling)', () => {
    const result = validateProfileValues(FIELDS, { team: 'Analytics', secret: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing required field', () => {
    const result = validateProfileValues(FIELDS, { email: 'ada@example.com' });
    expect(result.ok).toBe(false);
  });

  it('treats empty strings as not supplied (optional fields pass, required fails)', () => {
    // Optional fields blank → fine; required `team` blank → rejected.
    expect(validateProfileValues(FIELDS, { team: 'Analytics', email: '' })).toMatchObject({
      ok: true,
    });
    expect(validateProfileValues(FIELDS, { team: '' })).toMatchObject({ ok: false });
  });

  it('rejects a malformed email and a non-numeric number', () => {
    expect(validateProfileValues(FIELDS, { team: 'A', email: 'not-an-email' }).ok).toBe(false);
    expect(validateProfileValues(FIELDS, { team: 'A', size: 'lots' }).ok).toBe(false);
  });

  it('rejects a select value outside the configured options', () => {
    expect(validateProfileValues(FIELDS, { team: 'A', tier: 'enterprise' }).ok).toBe(false);
  });

  it('rejects a non-object submission', () => {
    expect(validateProfileValues(FIELDS, null).ok).toBe(false);
    expect(validateProfileValues(FIELDS, 'nope').ok).toBe(false);
  });
});

describe('parseProfileFields', () => {
  it('parses a well-formed JSON column', () => {
    expect(parseProfileFields(FIELDS)).toHaveLength(4);
  });

  it('degrades to [] on a malformed column', () => {
    expect(parseProfileFields('garbage')).toEqual([]);
    expect(parseProfileFields([{ key: 'x' }])).toEqual([]); // missing required props
  });
});

describe('asProfileValues', () => {
  it('passes through a plain object and rejects non-objects', () => {
    expect(asProfileValues({ team: 'Analytics' })).toEqual({ team: 'Analytics' });
    expect(asProfileValues(null)).toBeNull();
    expect(asProfileValues(['a'])).toBeNull();
    expect(asProfileValues('x')).toBeNull();
  });
});
