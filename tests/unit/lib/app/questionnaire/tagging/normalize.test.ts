import { describe, it, expect } from 'vitest';

import { normalizeTagLabel } from '@/lib/app/questionnaire/tagging/normalize';

/**
 * Pin the case-insensitive tag dedup key (F2.2).
 *
 * `normalizedLabel` is `@@unique([versionId, normalizedLabel])`, so these rules
 * decide which labels collide. Case and surrounding/repeated whitespace fold;
 * diacritics are preserved (a label is display text, not a slug).
 */
describe('normalizeTagLabel', () => {
  it('lowercases', () => {
    expect(normalizeTagLabel('Pricing')).toBe('pricing');
    expect(normalizeTagLabel('PRICING')).toBe('pricing');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTagLabel('  pricing  ')).toBe('pricing');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeTagLabel('go   to   market')).toBe('go to market');
    expect(normalizeTagLabel('go\tto\nmarket')).toBe('go to market');
  });

  it('folds case + whitespace together so near-duplicates collide', () => {
    expect(normalizeTagLabel('  Go To  Market ')).toBe(normalizeTagLabel('go to market'));
  });

  it('preserves diacritics (display text, not a slug)', () => {
    expect(normalizeTagLabel('Évaluation')).toBe('évaluation');
  });
});
