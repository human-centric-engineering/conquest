/**
 * Chat-transcript export — where a section heading falls (P21).
 *
 * Sectioned interviews tag each turn with the section it belongs to, and the download reads as one
 * conversation per section rather than one undifferentiated stretch. Both renderers — the plain-text
 * serialiser and the React-PDF document — need the same answer to the same question ("does a heading
 * go above this line, and what does it say?"), so the rule lives here once instead of twice.
 *
 * ## The rule, and why it is not a group-by
 *
 * A heading is emitted whenever a line's section label differs from the LAST ONE PRINTED. It is not
 * a grouping, and that distinction is load-bearing: under `free` navigation a respondent may work in
 * part one, move to part three, and come back. Those are two genuine visits to part one, minutes
 * apart, and a transcript that merged them into a single block would misreport when things were
 * said. The heading repeats because the visit repeated.
 *
 * An unlabelled line (an unsectioned session, or a turn recorded before P21) emits no heading and
 * does not clear the tracker. Nothing else changes: a model whose lines all lack a label yields
 * `heading: null` throughout, which is the flat transcript exactly as it rendered before this
 * existed.
 *
 * Pure: no Prisma, no React, no clock.
 */

import type { TranscriptTurnView } from '@/lib/app/questionnaire/export/transcript-types';

/** One transcript line, paired with the heading (if any) that precedes it. */
export interface TranscriptLineWithHeading {
  turn: TranscriptTurnView;
  /** The section heading to print above this line, or null when none is due. */
  heading: string | null;
}

/**
 * Pair each line with the section heading due above it.
 *
 * Returns one entry per input line, in order, so a renderer maps over this instead of tracking
 * state in its own loop — which is what let the two renderers disagree in the first place.
 */
export function withSectionHeadings(
  turns: readonly TranscriptTurnView[]
): TranscriptLineWithHeading[] {
  let lastPrinted: string | undefined;
  return turns.map((turn) => {
    if (turn.sectionLabel && turn.sectionLabel !== lastPrinted) {
      lastPrinted = turn.sectionLabel;
      return { turn, heading: turn.sectionLabel };
    }
    return { turn, heading: null };
  });
}
