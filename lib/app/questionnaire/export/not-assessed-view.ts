/**
 * "What this interview did not cover", as a document renders it — Conditional Topics (P17). Pure.
 *
 * The exports already narrow silently: every listing is filtered to what was in scope, so an area
 * an adaptive interview decided not to ask about simply is not there. A reader — often months
 * later, often not the respondent — cannot tell a short instrument from a narrowed one, and the
 * report's method panel that would have told them does not travel with a downloaded file.
 *
 * The formatting lives here rather than in the React-PDF component for the reason the render test
 * states: react-pdf emits a binary buffer, so anything asserted about wording has to be assertable
 * without parsing a PDF.
 */

import type { NotAssessedTopic } from '@/lib/app/questionnaire/scope/types';

/** The two lists a document prints, already worded. Both empty for a non-adaptive session. */
export interface NotAssessedView {
  /** Areas the interview never asked about. */
  skipped: string[];
  /** Areas it sampled — some members asked, the area not assessed. */
  sampled: string[];
}

/** The standing caveat above the lists: what a missing question in the record above means. */
export const NOT_ASSESSED_NOTE =
  'This interview was tailored to the answers given, so not every area was put to the respondent. ' +
  'The areas below were left out or only sampled — a question missing from the record above was ' +
  'never asked, rather than skipped.';

/**
 * One line per topic: its label and how many of its questions went unasked.
 *
 * The count is not decoration. A topic name alone does not say how much was left out — "Pricing"
 * could be one question or twelve — and a reader deciding whether the omission matters to them is
 * exactly the reader this list exists for.
 */
function line(topic: NotAssessedTopic): string {
  return `${topic.label} — ${topic.questionCount} question${topic.questionCount === 1 ? '' : 's'}`;
}

/**
 * Split the not-assessed topics into the two claims a document may make about them.
 *
 * Separate lists, always: **"we looked lightly" and "we did not look" are different claims** about
 * the person holding the document. Merging them would overstate one and understate the other, which
 * is the failure the whole `partial` flag exists to prevent.
 */
export function buildNotAssessedView(topics: readonly NotAssessedTopic[]): NotAssessedView {
  return {
    skipped: topics.filter((t) => !t.partial).map(line),
    sampled: topics.filter((t) => t.partial).map(line),
  };
}
