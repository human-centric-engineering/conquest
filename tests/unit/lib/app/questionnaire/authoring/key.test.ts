import { describe, it, expect } from 'vitest';

import { slugifyKey, nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';

/**
 * Pin the per-version `key` slug rules (F2.1 / PR2).
 *
 * `key` anchors answers and re-ingest and is `@@unique([versionId, key])`. These
 * tests fix the normalisation (so the same prompt always yields the same key) and
 * the in-memory disambiguation the writer uses before hitting the DB.
 */
describe('slugifyKey', () => {
  it('lowercases and snake_cases a prompt', () => {
    expect(slugifyKey('What is your full name?')).toBe('what_is_your_full_name');
  });

  it('collapses runs of punctuation/whitespace to a single underscore', () => {
    expect(slugifyKey('Email   address (work) -- primary!!')).toBe('email_address_work_primary');
  });

  it('strips accents via NFKD normalisation', () => {
    expect(slugifyKey('Prénom / Âge')).toBe('prenom_age');
  });

  it('falls back to "question" when nothing slug-able remains', () => {
    expect(slugifyKey('¿?!  —  ')).toBe('question');
  });

  it('truncates to 60 chars with no trailing underscore', () => {
    const key = slugifyKey('a '.repeat(80));
    expect(key.length).toBeLessThanOrEqual(60);
    expect(key.endsWith('_')).toBe(false);
  });
});

describe('nextAvailableKey', () => {
  it('returns the base when it is free', () => {
    expect(nextAvailableKey('smoker', new Set())).toBe('smoker');
  });

  it('suffixes _2, _3 … past taken keys', () => {
    const taken = new Set(['smoker', 'smoker_2']);
    expect(nextAvailableKey('smoker', taken)).toBe('smoker_3');
  });

  it('keeps the suffixed key within the length cap', () => {
    const base = 'x'.repeat(60);
    const candidate = nextAvailableKey(base, new Set([base]));
    expect(candidate.length).toBeLessThanOrEqual(60);
    expect(candidate.endsWith('_2')).toBe(true);
  });
});
