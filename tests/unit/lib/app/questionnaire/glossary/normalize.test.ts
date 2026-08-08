/**
 * Glossary surface normalisation — unit tests (P16).
 *
 * This function is the single source of "are these the same term?" for three consumers that must
 * agree: the DB uniqueness key, the save schema's duplicate check, and the respondent-facing
 * matcher's index. A regression here shows up as a term that cannot be saved twice but never
 * underlines, so the folding rules are pinned explicitly rather than assumed.
 *
 * @see lib/app/questionnaire/glossary/normalize.ts
 */

import { describe, it, expect } from 'vitest';

import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary/normalize';

describe('normalizeGlossarySurface', () => {
  it('lowercases so casing never splits one term into two', () => {
    expect(normalizeGlossarySurface('Ego')).toBe('ego');
    expect(normalizeGlossarySurface('HIGHER SELF')).toBe('higher self');
  });

  it('folds hyphens and dashes to spaces — the motivating "higher-self" case', () => {
    expect(normalizeGlossarySurface('higher-self')).toBe('higher self');
    expect(normalizeGlossarySurface('higher–self')).toBe('higher self');
    expect(normalizeGlossarySurface('higher—self')).toBe('higher self');
    expect(normalizeGlossarySurface('higher‐self')).toBe('higher self');
    // The whole point: the two spellings collapse to one key.
    expect(normalizeGlossarySurface('higher-self')).toBe(normalizeGlossarySurface('higher self'));
  });

  it('folds curly and modifier apostrophes to a straight one', () => {
    expect(normalizeGlossarySurface('respondent’s self')).toBe("respondent's self");
    expect(normalizeGlossarySurface('respondent‘s self')).toBe("respondent's self");
    expect(normalizeGlossarySurface('respondentʼs self')).toBe("respondent's self");
    // A term pasted from Word matches the same term typed in a browser.
    expect(normalizeGlossarySurface('respondent’s self')).toBe(
      normalizeGlossarySurface("respondent's self")
    );
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeGlossarySurface('  higher   self  ')).toBe('higher self');
    expect(normalizeGlossarySurface('higher\tself')).toBe('higher self');
    expect(normalizeGlossarySurface('higher\nself')).toBe('higher self');
  });

  it('returns an empty string for input with no content', () => {
    expect(normalizeGlossarySurface('')).toBe('');
    expect(normalizeGlossarySurface('   ')).toBe('');
    expect(normalizeGlossarySurface('-')).toBe('');
  });

  it('does NOT strip accents — an accent difference is a different word', () => {
    expect(normalizeGlossarySurface('éclat')).toBe('éclat');
    expect(normalizeGlossarySurface('éclat')).not.toBe(normalizeGlossarySurface('eclat'));
  });

  it('does NOT stem — it only folds surface punctuation and case', () => {
    expect(normalizeGlossarySurface('egoism')).toBe('egoism');
    expect(normalizeGlossarySurface('egoism')).not.toBe(normalizeGlossarySurface('ego'));
  });

  it('is idempotent — normalising an already-normalised surface is a no-op', () => {
    const once = normalizeGlossarySurface('  Higher-Self ’n’ Ego  ');
    expect(normalizeGlossarySurface(once)).toBe(once);
  });
});
