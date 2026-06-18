/**
 * Unit test: session support-reference util.
 *
 * Pins the alphabet (Crockford base32 — no I/L/O/U), the grouping format, and the
 * forgiving normalisation (folds look-alikes, strips grouping) so display ↔ lookup round-trip.
 */

import { describe, it, expect } from 'vitest';

import {
  generateSessionRef,
  formatSessionRef,
  normalizeSessionRef,
  SESSION_REF_LENGTH,
} from '@/lib/app/questionnaire/session-ref';

describe('generateSessionRef', () => {
  it('produces an 8-char code from the Crockford alphabet (no I/L/O/U)', () => {
    for (let i = 0; i < 200; i++) {
      const ref = generateSessionRef();
      expect(ref).toHaveLength(SESSION_REF_LENGTH);
      expect(ref).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/); // excludes I, L, O, U
    }
  });

  it('is overwhelmingly unique across a batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSessionRef());
    expect(seen.size).toBe(1000);
  });
});

describe('formatSessionRef', () => {
  it('groups an 8-char code as XXXX-XXXX, uppercased', () => {
    expect(formatSessionRef('7f3k9m2p')).toBe('7F3K-9M2P');
  });

  it('returns non-8-char input uppercased without grouping', () => {
    expect(formatSessionRef('abc')).toBe('ABC');
  });
});

describe('normalizeSessionRef', () => {
  it('strips grouping dashes/spaces and uppercases', () => {
    expect(normalizeSessionRef('7f3k-9m2p')).toBe('7F3K9M2P');
    expect(normalizeSessionRef(' 7f3k 9m2p ')).toBe('7F3K9M2P');
  });

  it('folds the Crockford look-alikes a human mistypes (O→0, I/L→1)', () => {
    expect(normalizeSessionRef('OI1L-0O1I')).toBe('01110011');
  });

  it('round-trips a formatted ref back to its raw form', () => {
    const raw = generateSessionRef();
    expect(normalizeSessionRef(formatSessionRef(raw))).toBe(raw);
  });
});
