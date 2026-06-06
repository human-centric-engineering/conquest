/**
 * formatAnswerValue — presentational answer formatter for the panel (F7.2).
 *
 * Pins the per-type rendering branches: the em-dash for empty/nullish, array join
 * (incl. nested + empty), Yes/No booleans, numbers/bigints, the JSON object fallback,
 * and the serialise-failure catch.
 *
 * @see components/app/questionnaire/panel/format-answer-value.ts
 */

import { describe, it, expect } from 'vitest';

import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';

describe('formatAnswerValue', () => {
  it('renders an em-dash for null and undefined', () => {
    expect(formatAnswerValue(null)).toBe('—');
    expect(formatAnswerValue(undefined)).toBe('—');
  });

  it('renders an em-dash for an empty or whitespace-only string', () => {
    expect(formatAnswerValue('')).toBe('—');
    expect(formatAnswerValue('   ')).toBe('—');
  });

  it('returns a non-empty string verbatim', () => {
    expect(formatAnswerValue('Acme Corp')).toBe('Acme Corp');
  });

  it('reads booleans as Yes / No', () => {
    expect(formatAnswerValue(true)).toBe('Yes');
    expect(formatAnswerValue(false)).toBe('No');
  });

  it('stringifies numbers and bigints', () => {
    expect(formatAnswerValue(42)).toBe('42');
    expect(formatAnswerValue(0)).toBe('0');
    expect(formatAnswerValue(10n)).toBe('10');
  });

  it('joins arrays with commas, formatting each element', () => {
    expect(formatAnswerValue(['Red', 'Green', 'Blue'])).toBe('Red, Green, Blue');
    expect(formatAnswerValue([1, true, 'x'])).toBe('1, Yes, x');
  });

  it('renders an em-dash for an empty array', () => {
    expect(formatAnswerValue([])).toBe('—');
  });

  it('falls back to JSON for plain objects', () => {
    expect(formatAnswerValue({ city: 'London', zip: 'EC1' })).toBe('{"city":"London","zip":"EC1"}');
  });

  it('renders an em-dash when the value cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatAnswerValue(circular)).toBe('—');
  });
});
