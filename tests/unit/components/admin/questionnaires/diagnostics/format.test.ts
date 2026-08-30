/**
 * Unit tests: the Diagnostics formatters (F8.5, extended by F20.1).
 *
 * These decide what an operator reads off the Diagnostics tab, so the cases that matter are the
 * ones where a wrong answer would be *plausible*: an em dash where a real zero belongs, a share
 * that silently renders as `NaN%`, a millisecond figure that changes unit at the wrong boundary.
 */

import { describe, it, expect } from 'vitest';

import {
  formatCount,
  formatMs,
  formatShare,
  formatWhen,
  severityVariant,
} from '@/components/admin/questionnaires/diagnostics/format';

describe('formatCount', () => {
  it('groups thousands so a six-figure token total stays readable', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('renders a real zero as 0, not an em dash', () => {
    // "0 errors" and "we did not measure errors" are different facts; only the latter is a dash.
    expect(formatCount(0)).toBe('0');
  });

  it('renders absent values as an em dash', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
  });
});

describe('formatMs', () => {
  it('keeps sub-second values in milliseconds', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(820)).toBe('820 ms');
    expect(formatMs(999)).toBe('999 ms');
  });

  it('switches to seconds at exactly one second', () => {
    expect(formatMs(1000)).toBe('1.0 s');
    expect(formatMs(3400)).toBe('3.4 s');
    expect(formatMs(50929 / 10)).toBe('5.1 s');
  });

  it('rounds rather than truncating a fractional millisecond', () => {
    // Per-turn figures are a division, so they are almost never whole.
    expect(formatMs(371.1)).toBe('371 ms');
    expect(formatMs(878.5)).toBe('879 ms');
  });

  it('renders absent values as an em dash', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
  });
});

describe('formatShare', () => {
  it('renders a 0–1 share as a whole percent', () => {
    expect(formatShare(0.75)).toBe('75%');
    expect(formatShare(0.026)).toBe('3%');
    expect(formatShare(1)).toBe('100%');
  });

  it('distinguishes a measured zero from nothing measured', () => {
    // 0% overhead is a finding. A null residual share means no turn recorded a duration at all,
    // and showing that as "0%" would claim a measurement that was never taken.
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(null)).toBe('—');
    expect(formatShare(undefined)).toBe('—');
  });

  it('renders a non-finite share as an em dash rather than NaN%', () => {
    expect(formatShare(Number.NaN)).toBe('—');
    expect(formatShare(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatWhen', () => {
  it('renders a timestamp down to the minute, without the year', () => {
    // Midday UTC, so every timezone this is read from still lands on the 15th.
    const out = formatWhen('2026-03-15T12:00:00.000Z');
    expect(out).toMatch(/Mar/);
    expect(out).toMatch(/15/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    // The window is days wide, so a year would be noise in every cell of the table.
    expect(out).not.toMatch(/2026/);
  });

  it('renders a missing timestamp as an em dash', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen(undefined)).toBe('—');
    expect(formatWhen('')).toBe('—');
  });

  it('renders an unparseable timestamp as an em dash rather than "Invalid Date"', () => {
    // These cells are fed straight from stored JSON, so a malformed value is a real input — and
    // "Invalid Date" in a diagnostics table reads as a finding about the session, not about us.
    expect(formatWhen('not a date')).toBe('—');
  });
});

describe('severityVariant', () => {
  it('maps each severity to its badge variant, defaulting unknown to outline', () => {
    expect(severityVariant('error')).toBe('destructive');
    expect(severityVariant('warning')).toBe('secondary');
    expect(severityVariant('info')).toBe('outline');
    // An unrecognised severity must still render a badge, not crash the row.
    expect(severityVariant('something-new')).toBe('outline');
  });
});
