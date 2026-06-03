import { describe, it, expect } from 'vitest';

import {
  createTagSchema,
  updateTagSchema,
  setQuestionTagsSchema,
} from '@/lib/app/questionnaire/tagging/schemas';

/**
 * Pin the tagging request-body contracts (F2.2). Provenance-free, pure Zod — the
 * route derives `normalizedLabel` and version-checks the ids, so these just fix the
 * client-input shape: non-empty bounded labels, the colour allowlist, and the
 * replace-set assignment array.
 */
describe('createTagSchema', () => {
  it('accepts a label with an allowlisted colour', () => {
    const parsed = createTagSchema.parse({ label: 'Pricing', color: 'blue' });
    expect(parsed).toEqual({ label: 'Pricing', color: 'blue' });
  });

  it('accepts a label with no colour', () => {
    expect(createTagSchema.parse({ label: 'Pricing' })).toEqual({ label: 'Pricing' });
  });

  it('trims the label', () => {
    expect(createTagSchema.parse({ label: '  Pricing  ' }).label).toBe('Pricing');
  });

  it('rejects an empty / whitespace-only label', () => {
    expect(createTagSchema.safeParse({ label: '' }).success).toBe(false);
    expect(createTagSchema.safeParse({ label: '   ' }).success).toBe(false);
  });

  it('rejects an off-allowlist colour', () => {
    expect(createTagSchema.safeParse({ label: 'Pricing', color: 'turquoise' }).success).toBe(false);
  });

  it('rejects a label over 60 chars', () => {
    expect(createTagSchema.safeParse({ label: 'a'.repeat(61) }).success).toBe(false);
  });
});

describe('updateTagSchema', () => {
  it('accepts a rename', () => {
    expect(updateTagSchema.parse({ label: 'Renamed' })).toEqual({ label: 'Renamed' });
  });

  it('accepts a recolour, including clearing to null', () => {
    expect(updateTagSchema.parse({ color: 'green' })).toEqual({ color: 'green' });
    expect(updateTagSchema.parse({ color: null })).toEqual({ color: null });
  });

  it('rejects an empty patch (no editable field)', () => {
    expect(updateTagSchema.safeParse({}).success).toBe(false);
  });
});

describe('setQuestionTagsSchema', () => {
  it('accepts a list of tag ids', () => {
    expect(setQuestionTagsSchema.parse({ tagIds: ['a', 'b'] })).toEqual({ tagIds: ['a', 'b'] });
  });

  it('accepts an empty array (clears all)', () => {
    expect(setQuestionTagsSchema.parse({ tagIds: [] })).toEqual({ tagIds: [] });
  });

  it('rejects a missing tagIds key', () => {
    expect(setQuestionTagsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty-string id', () => {
    expect(setQuestionTagsSchema.safeParse({ tagIds: [''] }).success).toBe(false);
  });
});
