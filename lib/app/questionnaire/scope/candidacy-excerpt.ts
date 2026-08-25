/**
 * What the ingestion-time candidacy check actually reads (F17.22 Phase 3).
 *
 * The check is cheap by design — it runs on every fresh upload — so it cannot read a long
 * instrument in full. It used to read the first 20,000 characters and nothing else, which is the
 * wrong 20,000 for exactly the documents it exists to catch: a routing page, a guardrails tab, an
 * eligibility appendix or a "how to use this" note is very often at the BACK of an instrument,
 * behind the questions. A workbook whose Routing sheet is flattened last would be read as though
 * it said nothing about routing at all.
 *
 * So the excerpt is composed rather than sliced: the head, the tail, and a window around every
 * place the document uses routing language, in document order, with elisions marked. The total
 * stays inside the same budget — this is about spending it better, not spending more.
 *
 * Pure: no Prisma, no Next, no LLM. Its output is a string the prompt builder embeds.
 */

/** Total characters the excerpt may carry — the same budget the old head-slice spent. */
export const CANDIDACY_MAX_CHARS = 20_000;

/**
 * Front of the document. Larger than the tail because a preamble, a "how to use this" page and a
 * respondent-eligibility note are all front-matter conventions, and because a document short
 * enough to fit head+tail is returned whole anyway.
 */
export const CANDIDACY_HEAD_CHARS = 10_000;

/** Back of the document — appendices, guardrail tables, scoring notes, a flattened routing sheet. */
export const CANDIDACY_TAIL_CHARS = 4_000;

/** How much to keep after a routing term, and how much of the line leading up to it. */
export const CANDIDACY_WINDOW_CHARS = 2_000;
const CANDIDACY_WINDOW_LEAD_CHARS = 400;

/**
 * A cap on windows, so a document that says "score" on every page cannot turn the excerpt into
 * confetti of 40 disconnected fragments — which reads worse than a contiguous slice and quotes
 * worse, and quoting is what the check is graded on.
 */
const MAX_WINDOWS = 8;

/** Marks where text was dropped, so the model never reads two distant spans as adjacent. */
export const CANDIDACY_ELISION = '\n\n[…]\n\n';

/**
 * The language a document uses when it is telling you who gets asked what.
 *
 * Deliberately about ROUTING VOCABULARY, not about any subject matter: the same instrument shape
 * turns up in clinical screeners, procurement questionnaires and staff surveys, and a term list
 * tuned to one domain would silently fail the others. Prefix-matched rather than word-bounded at
 * the end (`branch` catches `branching`, `eligib` catches `eligible`/`eligibility`), because the
 * cost of one extra window is a few hundred characters and the cost of a miss is the whole point
 * of the check.
 */
const ROUTING_TERMS = [
  'routing',
  'route ',
  'eligib',
  'ineligib',
  'screener',
  'screening',
  'guardrail',
  'how to use',
  'skip logic',
  'skip to',
  'branch',
  'qualif',
  'disqualif',
  'applicab',
  'only ask',
  'only complete',
  'only if',
  'if applicable',
  'not applicable',
  'inclusion criteria',
  'exclusion criteria',
  'who answers',
  'who should answer',
  'facilitator',
  'interviewer note',
  'scoring',
] as const;

const ROUTING_PATTERN = new RegExp(
  ROUTING_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi'
);

interface Range {
  start: number;
  end: number;
}

export interface CandidacyExcerpt {
  /** What to give the model. Equal to the input when the document already fits the budget. */
  text: string;
  /** How many characters of the source were left out (0 when the document fits). */
  omittedChars: number;
  /**
   * Which routing terms earned a window, lower-cased and deduplicated. Logged rather than shown:
   * it is what lets an operator tell "the check read the routing page and still said no" from
   * "the check never saw it", which was previously unanswerable.
   */
  matchedTerms: string[];
}

/** Merge overlapping/touching ranges, in document order. */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** How much of `candidate` is not already covered by `ranges` — what adding it would cost. */
function uncoveredChars(candidate: Range, ranges: Range[]): number {
  let uncovered = candidate.end - candidate.start;
  for (const range of mergeRanges(ranges)) {
    const overlap = Math.min(candidate.end, range.end) - Math.max(candidate.start, range.start);
    if (overlap > 0) uncovered -= overlap;
  }
  return Math.max(0, uncovered);
}

/**
 * Compose what the candidacy check reads: head + tail + a window around each routing term, in
 * document order, elisions marked.
 *
 * A document inside the budget is returned untouched — the composition only ever applies where a
 * slice would otherwise have thrown text away.
 */
export function selectCandidacyExcerpt(
  documentText: string,
  options: { maxChars?: number } = {}
): CandidacyExcerpt {
  const maxChars = options.maxChars ?? CANDIDACY_MAX_CHARS;
  if (documentText.length <= maxChars) {
    return { text: documentText, omittedChars: 0, matchedTerms: [] };
  }

  const head: Range = { start: 0, end: Math.min(CANDIDACY_HEAD_CHARS, documentText.length) };
  const tail: Range = {
    start: Math.max(head.end, documentText.length - CANDIDACY_TAIL_CHARS),
    end: documentText.length,
  };
  const ranges: Range[] = [head, tail];

  // Whatever the head and tail did not already spend is what the windows have to work with.
  const windowBudget = Math.max(0, maxChars - (head.end - head.start) - (tail.end - tail.start));
  let spent = 0;
  const matchedTerms = new Set<string>();

  ROUTING_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let windows = 0;
  while (windows < MAX_WINDOWS && (match = ROUTING_PATTERN.exec(documentText)) !== null) {
    const candidate: Range = {
      start: Math.max(0, match.index - CANDIDACY_WINDOW_LEAD_CHARS),
      end: Math.min(documentText.length, match.index + CANDIDACY_WINDOW_CHARS),
    };
    const cost = uncoveredChars(candidate, ranges);
    // A term already inside the head or tail costs nothing and still counts as read — recording it
    // keeps `matchedTerms` an answer to "did the check see routing language", not "did composing
    // the excerpt need extra room for it".
    if (cost === 0) {
      matchedTerms.add(match[0].toLowerCase().trim());
      continue;
    }
    if (spent + cost > windowBudget) continue;
    ranges.push(candidate);
    spent += cost;
    windows += 1;
    matchedTerms.add(match[0].toLowerCase().trim());
  }

  const merged = mergeRanges(ranges);
  const included = merged.reduce((sum, r) => sum + (r.end - r.start), 0);
  const text = merged
    .map((r) => documentText.slice(r.start, r.end))
    .join(CANDIDACY_ELISION)
    .trim();

  return {
    text,
    omittedChars: documentText.length - included,
    matchedTerms: [...matchedTerms].sort(),
  };
}
