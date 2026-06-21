/**
 * Round Additional Context ("interviewer briefing") — pure selection + formatting.
 *
 * Briefing entries are retrieved by DIRECT FK lookup (no vector search): the route loads a round's
 * entries for the bundled version, and for each asked question hands this module the set of question
 * slot ids the selection is about. We keep the **general** entries (`questionSlotId === null`, which
 * apply to the whole version) plus any entry **attributed** to one of those ids, format each as a
 * single line, and cap the result so the short interviewer phraser prompt stays focused.
 *
 * Pure (no Prisma / Next), so it's unit-testable and shared by the route + any preview surface. The
 * DB read lives in the route `_lib` (`round-briefing.ts`); this only shapes what was loaded.
 */

/** The minimal entry shape the selector reads (the route projects rows into this). */
export interface BriefingEntryLite {
  /** null = general (whole-version) briefing; else the attributed question slot id. */
  questionSlotId: string | null;
  title: string;
  content: string;
}

/** Hard cap on injected entries — protects the short phraser prompt's token budget. */
export const BRIEFING_MAX_ENTRIES = 12;

/** Per-entry content cap (chars) before truncation — keeps any one fact from dominating. */
export const BRIEFING_MAX_CONTENT_CHARS = 600;

/** Truncate to `max` chars on a word boundary where possible, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/**
 * Select + format the briefing lines for the currently-asked question. Keeps general entries and any
 * attributed to `relevantQuestionSlotIds`, in the order given (the caller orders by `ordinal`), caps
 * to {@link BRIEFING_MAX_ENTRIES}, and renders each as `"<title>: <content>"` with the content
 * truncated. Returns `[]` when nothing applies — the prompt section then collapses to nothing.
 */
export function selectBriefingLines(
  entries: readonly BriefingEntryLite[],
  relevantQuestionSlotIds: ReadonlySet<string>
): string[] {
  return entries
    .filter((e) => e.questionSlotId === null || relevantQuestionSlotIds.has(e.questionSlotId))
    .slice(0, BRIEFING_MAX_ENTRIES)
    .map((e) => {
      const title = e.title.trim();
      const content = truncate(e.content, BRIEFING_MAX_CONTENT_CHARS);
      return title ? `${title}: ${content}` : content;
    })
    .filter((line) => line.trim().length > 0);
}
