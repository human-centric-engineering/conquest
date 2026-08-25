/**
 * Unit tests: what the ingestion-time candidacy check reads (F17.22 Phase 3).
 *
 * The failure this module exists to stop is silent and total: a document whose routing page sits
 * behind the questions used to be read as though it said nothing about routing, and the check
 * answered `false` on evidence it never saw. So the assertions here are about REACH — that a
 * routing term deep in a long document survives into the excerpt — rather than about the exact
 * character arithmetic, which is tuning.
 */

import { describe, it, expect } from 'vitest';

import {
  CANDIDACY_ELISION,
  CANDIDACY_MAX_CHARS,
  selectCandidacyExcerpt,
} from '@/lib/app/questionnaire/scope/candidacy-excerpt';

/** Filler with no routing vocabulary in it, so only the planted terms can match. */
function filler(chars: number, word = 'question about the team '): string {
  return word.repeat(Math.ceil(chars / word.length)).slice(0, chars);
}

describe('selectCandidacyExcerpt', () => {
  it('returns a document that already fits, untouched', () => {
    const doc = filler(5_000);
    const excerpt = selectCandidacyExcerpt(doc);

    expect(excerpt.text).toBe(doc);
    expect(excerpt.omittedChars).toBe(0);
    expect(excerpt.text).not.toContain(CANDIDACY_ELISION);
  });

  it('reaches routing language buried in the middle of a long document', () => {
    // The regression in one test: a 20k head-slice ends at 20,000, and this sits at ~60,000.
    const marker = 'ROUTING RULES: only ask Section 6 of franchise owners.';
    const doc = `${filler(60_000)}${marker}${filler(60_000)}`;

    const excerpt = selectCandidacyExcerpt(doc);

    expect(excerpt.text).toContain(marker);
    expect(excerpt.matchedTerms).toContain('routing');
  });

  it('reaches a routing page at the very back — the workbook case', () => {
    // An .xlsx flattened to text puts its Routing tab last. The old slice never saw it.
    const marker = 'Eligibility: skip Section 14 unless headcount is over 50.';
    const doc = `${filler(80_000)}\n\n${marker}`;

    const excerpt = selectCandidacyExcerpt(doc);

    expect(excerpt.text).toContain(marker);
  });

  it('still carries the front of the document', () => {
    const opening = 'HOW TO USE THIS INSTRUMENT — read before administering.';
    const doc = `${opening}${filler(80_000)}`;

    expect(selectCandidacyExcerpt(doc).text.startsWith(opening)).toBe(true);
  });

  it('marks where it dropped text, so two distant spans never read as adjacent', () => {
    const doc = `${filler(60_000)}Guardrail G03 applies here.${filler(60_000)}`;
    const excerpt = selectCandidacyExcerpt(doc);

    expect(excerpt.text).toContain(CANDIDACY_ELISION);
    expect(excerpt.omittedChars).toBeGreaterThan(0);
  });

  it('stays inside the budget it was given', () => {
    // The point of the change is spending the same budget better, not spending more: this read
    // happens on EVERY upload, which is what makes it affordable at all.
    const doc = `${filler(30_000)}routing${filler(30_000)}eligibility${filler(30_000)}scoring${filler(30_000)}`;
    const excerpt = selectCandidacyExcerpt(doc);

    // Elision markers are the only thing the excerpt adds to the source characters it selected.
    const elisions = excerpt.text.split(CANDIDACY_ELISION).length - 1;
    expect(excerpt.text.length).toBeLessThanOrEqual(
      CANDIDACY_MAX_CHARS + elisions * CANDIDACY_ELISION.length
    );
  });

  it('does not shred the excerpt when a term appears on every page', () => {
    // "scoring" 200 times must not produce 200 fragments — a confetti excerpt reads worse and
    // quotes worse, and the check is graded on quoting.
    const doc = Array.from({ length: 200 }, () => `${filler(600)} scoring notes `).join('');
    const excerpt = selectCandidacyExcerpt(doc);

    expect(excerpt.text.split(CANDIDACY_ELISION).length - 1).toBeLessThanOrEqual(10);
  });

  it('reports the routing terms it found, including ones already inside the head', () => {
    // `matchedTerms` answers "did the check see routing language at all" — an operator reading
    // "it said no" needs to know whether it read the routing page or never reached it.
    const doc = `Screener: confirm the respondent is a manager.${filler(80_000)}`;
    const excerpt = selectCandidacyExcerpt(doc);

    expect(excerpt.matchedTerms).toContain('screener');
  });

  it('finds no terms in a document that never talks about routing', () => {
    const excerpt = selectCandidacyExcerpt(filler(60_000));

    expect(excerpt.matchedTerms).toEqual([]);
    // Head and tail are still carried — a document with no routing vocabulary can still describe
    // routing in its own words, and the check, not this module, is what decides.
    expect(excerpt.text.length).toBeGreaterThan(0);
  });

  it('honours a caller-supplied budget', () => {
    const doc = filler(60_000);
    expect(selectCandidacyExcerpt(doc, { maxChars: 100_000 }).text).toBe(doc);
  });
});
