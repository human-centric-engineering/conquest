/**
 * Glossary save schema — unit tests (P16).
 *
 * `saveGlossarySchema` carries the two invariants the database cannot express, and both exist to
 * stop a specific failure reaching a human:
 *
 *   1. duplicate normalised terms — the DB's unique index would catch these too, but only as a
 *      500 AFTER a launched version has already been forked;
 *   2. an `accepted` term with nothing selected — which would render to a respondent as a dotted
 *      underline opening an empty popover.
 *
 * @see lib/app/questionnaire/glossary/schemas.ts
 */

import { describe, it, expect } from 'vitest';

import {
  glossaryDefinitionInputSchema,
  glossaryTermInputSchema,
  saveGlossarySchema,
} from '@/lib/app/questionnaire/glossary/schemas';
import { GLOSSARY_MAX_TERMS_PER_VERSION } from '@/lib/app/questionnaire/glossary/types';

/** A minimal valid accepted term: one selected definition. */
function acceptedTerm(term: string, text = 'A definition.') {
  return {
    term,
    status: 'accepted' as const,
    definitions: [{ text, selected: true }],
  };
}

describe('glossaryDefinitionInputSchema', () => {
  it('defaults selected/edited to false and source to ai_proposed', () => {
    const parsed = glossaryDefinitionInputSchema.parse({ text: 'The observing self.' });
    expect(parsed).toMatchObject({ selected: false, edited: false, source: 'ai_proposed' });
  });

  it('trims the text and rejects an empty definition', () => {
    expect(glossaryDefinitionInputSchema.parse({ text: '  spaced  ' }).text).toBe('spaced');
    expect(glossaryDefinitionInputSchema.safeParse({ text: '   ' }).success).toBe(false);
  });

  it('rejects a definition beyond the length cap', () => {
    expect(glossaryDefinitionInputSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('rejects an unknown source rather than coercing it', () => {
    expect(
      glossaryDefinitionInputSchema.safeParse({ text: 'ok', source: 'wikipedia' }).success
    ).toBe(false);
  });
});

describe('glossaryTermInputSchema', () => {
  it('defaults a hand-added term to admin source and proposed status', () => {
    const parsed = glossaryTermInputSchema.parse({ term: 'ego', definitions: [] });
    expect(parsed).toMatchObject({ status: 'proposed', source: 'admin', aliases: [] });
  });

  it('rejects a term longer than a term plausibly is', () => {
    expect(
      glossaryTermInputSchema.safeParse({ term: 'x'.repeat(121), definitions: [] }).success
    ).toBe(false);
  });

  it('caps candidate definitions at four', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ text: `sense ${i}` }));
    expect(glossaryTermInputSchema.safeParse({ term: 'ego', definitions: five }).success).toBe(
      false
    );
    expect(
      glossaryTermInputSchema.safeParse({ term: 'ego', definitions: five.slice(0, 4) }).success
    ).toBe(true);
  });

  it('caps aliases at eight', () => {
    const aliases = Array.from({ length: 9 }, (_, i) => `alias${i}`);
    expect(
      glossaryTermInputSchema.safeParse({ term: 'ego', aliases, definitions: [] }).success
    ).toBe(false);
  });
});

describe('saveGlossarySchema', () => {
  it('accepts an empty set — clearing the glossary is a legitimate save', () => {
    expect(saveGlossarySchema.safeParse({ terms: [] }).success).toBe(true);
  });

  it('accepts a term carrying several selected senses — multi-select is deliberate', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [
        {
          term: 'ego',
          status: 'accepted',
          definitions: [
            { text: 'The constructed self that seeks approval.', selected: true },
            { text: 'The Jungian conscious centre of the personality.', selected: true },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects two terms that normalise to the same surface', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [acceptedTerm('higher-self'), acceptedTerm('Higher Self')],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join('.') === 'terms.1.term');
    expect(issue?.message).toContain('Duplicate term');
    // Flagged on the REPEAT (index 1), not on the term that got there first.
    expect(result.error.issues.some((i) => i.path.join('.') === 'terms.0.term')).toBe(false);
  });

  it('allows two distinct terms that merely share a word', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [acceptedTerm('higher self'), acceptedTerm('self')],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an accepted term with no definition selected', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [
        {
          term: 'ego',
          status: 'accepted',
          definitions: [{ text: 'A candidate nobody ticked.', selected: false }],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.') === 'terms.0.definitions')).toBe(true);
  });

  it('rejects an accepted term with no definitions at all', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [{ term: 'ego', status: 'accepted', definitions: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('allows a proposed or rejected term to carry nothing selected', () => {
    // Only `accepted` is gated — an unadjudicated proposal and a turned-down term are both inert.
    for (const status of ['proposed', 'rejected'] as const) {
      const result = saveGlossarySchema.safeParse({
        terms: [{ term: 'ego', status, definitions: [{ text: 'Unticked.', selected: false }] }],
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a term with no letters or numbers', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [{ term: '---', status: 'proposed', definitions: [] }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain('at least one letter or number');
  });

  it('enforces the per-version term cap', () => {
    const build = (count: number) => ({
      terms: Array.from({ length: count }, (_, i) => acceptedTerm(`term ${i}`)),
    });
    expect(saveGlossarySchema.safeParse(build(GLOSSARY_MAX_TERMS_PER_VERSION)).success).toBe(true);
    expect(saveGlossarySchema.safeParse(build(GLOSSARY_MAX_TERMS_PER_VERSION + 1)).success).toBe(
      false
    );
  });

  it('reports every offending term, not just the first', () => {
    const result = saveGlossarySchema.safeParse({
      terms: [
        acceptedTerm('ego'),
        { term: 'higher self', status: 'accepted', definitions: [] },
        { term: 'shadow', status: 'accepted', definitions: [{ text: 'x', selected: false }] },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(2);
  });
});
