/**
 * Respondent report — one chapter per section (P21 phase D).
 *
 * A sectioned interview was experienced in parts, and the report that comes out of it should be
 * read in the same parts. This module turns the resolved sections plus the respondent's run into
 * the shape the report pipeline needs: an ordered list of chapters, each carrying its membership so
 * the answer transcript and the data-slot context can be bucketed into it.
 *
 * ## The distinction this exists to preserve
 *
 * A part the respondent NEVER OPENED is not a part they left blank. The report has to say so, and
 * it is the same distinction `NotAssessedTopic` already draws for Conditional Topics, for the same
 * reason: a report that blurs "we did not look" into "they had nothing to say" overstates its own
 * coverage, and the overstatement is invisible to the reader.
 *
 * Note it is a THIRD kind of gap, alongside the two the writer is already given. A question the
 * respondent skipped was asked and declined. An area Conditional Topics excluded was judged not to
 * apply. A section never opened applied, was offered, and was not reached — which licenses a
 * different sentence again ("this was not covered", and often "it is worth coming back to") than
 * either of the others.
 *
 * Pure: no Prisma, no clock, no LLM.
 */

import type { ExportDataSlotGroup } from '@/lib/app/questionnaire/export/types';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { SectionRun } from '@/lib/app/questionnaire/sections/run';

/** One part of the interview, as the report reads it back. */
export interface ReportChapter {
  key: string;
  /** The respondent-facing label. The heading the chapter is written under. */
  label: string;
  /** 1-based position in the run. */
  position: number;
  /**
   * True when the respondent actually worked in this part — it was opened, whether or not it was
   * finished. False means the interview never reached it.
   *
   * Reached-but-unfinished is deliberately `true`: the respondent was there, the writer has their
   * answers, and the honest description is a thin chapter rather than an absent one. Only "never
   * reached" earns the not-covered statement.
   */
  covered: boolean;
  questionKeys: readonly string[];
  dataSlotKeys: readonly string[];
}

/**
 * Build the chapter list from a session's resolved sections and its run.
 *
 * Sections are the ordering authority, not the run: the run's entry list is reconciled per turn and
 * may hold entries for sections that no longer resolve, which have no label to write a chapter
 * under. A section with no entry at all reads as never reached, which is exactly what it is.
 */
export function buildReportChapters(
  sections: readonly InterviewSection[],
  run: SectionRun | null
): ReportChapter[] {
  const statusByKey = new Map(run?.sections.map((entry) => [entry.key, entry.status]) ?? []);
  return sections.map((section, index) => ({
    key: section.key,
    label: section.label,
    position: index + 1,
    covered: (statusByKey.get(section.key) ?? 'not_started') !== 'not_started',
    questionKeys: section.questionKeys,
    dataSlotKeys: section.dataSlotKeys,
  }));
}

/**
 * The heading a chapter's content is grouped under. Shared by the answer transcript and the
 * data-slot context so a slot and the question behind it land under the same words.
 */
export function chapterHeading(chapter: ReportChapter): string {
  return chapter.label;
}

/**
 * The heading for content belonging to no chapter.
 *
 * This is not a defensive nicety: a `themes`- or `document`-sourced section set groups only what its
 * grouping knows about, so a question in no theme, or a data slot crossing a document section
 * boundary, genuinely belongs to no part of the run. Its answers are still the respondent's, and
 * dropping them to keep the chapter list tidy would silently shorten the report.
 */
export const UNCHAPTERED_HEADING = 'Other answers';

/**
 * Index every question key to its chapter heading. Later chapters do not overwrite earlier ones: a
 * key claimed by two sections is written under the first, so the report's order is stable.
 */
export function headingByQuestionKey(chapters: readonly ReportChapter[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const chapter of chapters) {
    for (const key of chapter.questionKeys) {
      if (!index.has(key)) index.set(key, chapterHeading(chapter));
    }
  }
  return index;
}

/** The data-slot twin of {@link headingByQuestionKey}, under the same first-wins rule. */
export function headingByDataSlotKey(chapters: readonly ReportChapter[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const chapter of chapters) {
    for (const key of chapter.dataSlotKeys) {
      if (!index.has(key)) index.set(key, chapterHeading(chapter));
    }
  }
  return index;
}

/**
 * The order the chapters' headings appear in, plus the trailing catch-all.
 *
 * Callers render in THIS order rather than in the order content happens to arrive, so the report
 * follows the interview's own shape even where a later part was answered first (which `free`
 * navigation permits, and `capture` tangents produce even under `sequential`).
 */
export function chapterHeadingOrder(chapters: readonly ReportChapter[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const chapter of chapters) {
    const heading = chapterHeading(chapter);
    if (seen.has(heading)) continue;
    seen.add(heading);
    order.push(heading);
  }
  order.push(UNCHAPTERED_HEADING);
  return order;
}

/**
 * Re-bucket the data-slot groups into chapters.
 *
 * The groups arrive themed, which is a different grouping over the same slots. Under a
 * `themes`-sourced section set the two coincide; under `topics` or `document` they do not, and the
 * chapters win — the respondent met the instrument in sections, and the report follows what they
 * experienced rather than how the slots were authored.
 *
 * Returns groups keyed by chapter heading, in chapter order, with an unfilled slot carried through
 * untouched: deciding what counts as filled belongs to the block builder that already makes that
 * call, not here.
 *
 * A section set that carries NO slot membership at all is left alone. That is every
 * `document`-sourced set by construction — `fromDocument` groups questions only and always writes
 * `dataSlotKeys: []` — and re-bucketing against it would drop every slot into the catch-all,
 * discarding the authored themes and putting nothing in their place. The chapters win where they
 * know something about the slots, and nowhere else.
 */
export function chapterDataSlotGroups(
  groups: readonly ExportDataSlotGroup[] | null | undefined,
  chapters: readonly ReportChapter[]
): ExportDataSlotGroup[] {
  if (!chapters.some((chapter) => chapter.dataSlotKeys.length > 0)) return [...(groups ?? [])];

  const headingFor = headingByDataSlotKey(chapters);
  const byHeading = new Map<string, ExportDataSlotGroup>();
  for (const heading of chapterHeadingOrder(chapters)) {
    byHeading.set(heading, { theme: heading, slots: [] });
  }
  for (const group of groups ?? []) {
    for (const slot of group.slots) {
      const heading = headingFor.get(slot.key) ?? UNCHAPTERED_HEADING;
      byHeading.get(heading)?.slots.push(slot);
    }
  }
  return [...byHeading.values()].filter((group) => group.slots.length > 0);
}
