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
  it('lowercases, snake_cases, and drops grammatical stopwords for a concise key', () => {
    // "what", "is", "your" are scaffolding — the key keeps the meaningful nouns.
    expect(slugifyKey('What is your full name?')).toBe('full_name');
  });

  it('keeps only the first few content words of a long prompt', () => {
    // The bug report: a whole-sentence key. Now trimmed to the essential content words.
    expect(slugifyKey('How would you describe your current morale at work?')).toBe(
      'describe_current_morale_work'
    );
  });

  it('caps a content-heavy prompt at the first four words', () => {
    expect(slugifyKey('Onboarding clarity speed support quality friction')).toBe(
      'onboarding_clarity_speed_support'
    );
  });

  it('collapses runs of punctuation/whitespace to a single underscore', () => {
    expect(slugifyKey('Email   address (work) -- primary!!')).toBe('email_address_work_primary');
  });

  it('strips accents via NFKD normalisation', () => {
    expect(slugifyKey('Prénom / Âge')).toBe('prenom_age');
  });

  it('falls back to the raw words when the prompt is all stopwords', () => {
    // No content survives the stopword filter — keep the words rather than emit "question".
    expect(slugifyKey('How are you?')).toBe('how_are_you');
  });

  it('falls back to "question" when nothing slug-able remains', () => {
    expect(slugifyKey('¿?!  —  ')).toBe('question');
  });

  it('truncates to 60 chars with no trailing underscore', () => {
    const long = 'antidisestablishmentarianism'; // 28 chars — four of these exceed 60
    const key = slugifyKey(`${long} ${long} ${long} ${long}`);
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
