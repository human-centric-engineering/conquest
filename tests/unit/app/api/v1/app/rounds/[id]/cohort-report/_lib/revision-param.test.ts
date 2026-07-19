/**
 * Unit tests for the shared cohort-report `?revision=` parsing.
 *
 * Both PDF export routes (version-scoped and round-scoped) previously carried a byte-identical
 * copy of this helper. Now that there is one definition, pin its contract directly — especially
 * the deliberate leniency, which is what stops a bad link 500ing instead of rendering the head.
 */

import { describe, it, expect } from 'vitest';

import { resolveRevisionSelector } from '@/app/api/v1/app/rounds/[id]/cohort-report/_lib/revision-param';

describe('resolveRevisionSelector', () => {
  it('maps the named selectors', () => {
    expect(resolveRevisionSelector('head')).toBe('head');
    expect(resolveRevisionSelector('published')).toBe('published');
  });

  it('defaults to the working head when the param is absent', () => {
    expect(resolveRevisionSelector(undefined)).toBe('head');
    expect(resolveRevisionSelector('')).toBe('head');
  });

  it('parses a positive integer revision number', () => {
    expect(resolveRevisionSelector('1')).toBe(1);
    expect(resolveRevisionSelector('42')).toBe(42);
  });

  it('falls back to head for anything unparseable rather than throwing', () => {
    // The export is a convenience surface — a malformed link should still render the current
    // report, not error. Zero and negatives are not valid revision numbers (they are 1-based).
    expect(resolveRevisionSelector('0')).toBe('head');
    expect(resolveRevisionSelector('-3')).toBe('head');
    expect(resolveRevisionSelector('1.5')).toBe('head');
    expect(resolveRevisionSelector('abc')).toBe('head');
    expect(resolveRevisionSelector('NaN')).toBe('head');
    expect(resolveRevisionSelector('Infinity')).toBe('head');
  });
});
