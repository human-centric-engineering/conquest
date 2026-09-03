/**
 * Unit: where a transcript's section heading falls (P21).
 *
 * The rule both transcript renderers read. What is pinned here is not "headings appear" but the
 * three judgements that make the rule right:
 *
 *  - a genuine REVISIT to a section prints its heading again, because it was a second visit;
 *  - an unlabelled line prints nothing and does not clear the tracker;
 *  - a model with no labels at all yields no headings, which is the flat transcript unchanged.
 *
 * @see lib/app/questionnaire/export/transcript-sections.ts
 */

import { describe, it, expect } from 'vitest';

import { withSectionHeadings } from '@/lib/app/questionnaire/export/transcript-sections';
import type { TranscriptTurnView } from '@/lib/app/questionnaire/export/transcript-types';

function line(text: string, sectionLabel?: string): TranscriptTurnView {
  return {
    speaker: 'respondent',
    text,
    at: '2026-06-01T10:00:00.000Z',
    ...(sectionLabel ? { sectionLabel } : {}),
  };
}

/** Just the headings, in order, for the shape assertions. */
function headings(turns: TranscriptTurnView[]): (string | null)[] {
  return withSectionHeadings(turns).map((entry) => entry.heading);
}

describe('withSectionHeadings', () => {
  it('emits no heading at all when no line carries a section label', () => {
    expect(headings([line('a'), line('b'), line('c')])).toEqual([null, null, null]);
  });

  it('emits a heading on the first line of a section and not on its later lines', () => {
    expect(headings([line('a', 'Context'), line('b', 'Context'), line('c', 'Context')])).toEqual([
      'Context',
      null,
      null,
    ]);
  });

  it('emits a fresh heading when the section changes', () => {
    expect(headings([line('a', 'Context'), line('b', 'Problem')])).toEqual(['Context', 'Problem']);
  });

  it('repeats a heading when the respondent comes back to a section', () => {
    // Free navigation lets a respondent work in Context, move to Problem, and return. Those are two
    // visits minutes apart, and merging them into one block would misreport when things were said.
    expect(
      headings([
        line('a', 'Context'),
        line('b', 'Problem'),
        line('c', 'Context'),
        line('d', 'Context'),
      ])
    ).toEqual(['Context', 'Problem', 'Context', null]);
  });

  it('leaves an unlabelled line alone without clearing the last heading printed', () => {
    // Sections turned on mid-session: the early turns belong to no section. They get no heading, and
    // they must not cause the section they interrupt to be re-announced.
    expect(headings([line('a'), line('b', 'Context'), line('c'), line('d', 'Context')])).toEqual([
      null,
      'Context',
      null,
      null,
    ]);
  });

  it('returns one entry per input line, carrying each line through untouched', () => {
    const turns = [line('a', 'Context'), line('b')];
    const paired = withSectionHeadings(turns);
    expect(paired).toHaveLength(2);
    expect(paired[0]?.turn).toBe(turns[0]);
    expect(paired[1]?.turn).toBe(turns[1]);
  });
});
