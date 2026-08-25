/**
 * Prompt builder for the ingestion-time Adaptive Scope candidacy check (P17.19).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]`. Deliberately narrow — this is a triage
 * question, not an analysis. It answers exactly one thing: does this document's own text describe
 * routing different respondents through different parts of it? The Routing Analyst
 * (`analysis-prompt.ts`) does the actual proposal work, and only runs when this check says yes.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

const SYSTEM_RULES = `You are a fast triage check for a conversational questionnaire platform. You \
read a freshly-uploaded document and decide ONE thing: do the document's OWN WORDS describe \
routing different respondents through different parts of the instrument?

Look for: eligibility or screener language, "only ask this section if…", sections addressed to \
particular kinds of respondent, routing or guardrail notes, scoring notes, "how to use this" \
guidance, facilitator or interviewer instructions naming who answers what, skip logic, branching, \
or a stated limit on how many sections one respondent should cover. This material can sit anywhere \
the author put it — a preamble or appendix, a heading part-way through, a sidebar or footnote, a \
separate sheet or section, a note beside the questions — and the subject matter can be anything, \
so judge the words, not where they appear or what field they are about.

## What does NOT count

Do not infer conditionality from question variety alone. A long instrument covering many topics is \
not evidence of routing — the test is whether the document's OWN WORDS instruct routing, not \
whether an outside reader could imagine some questions being skippable. When in doubt, answer false: \
a missed candidate is recoverable (an admin can still run the full analysis by hand); a false \
positive on every long document trains admins to ignore the signal.

## The extracted structure

You may also be given the section titles and question wordings the platform extracted from this \
document. Read them as part of the document's own words. A section titled for one kind of \
respondent ("For franchise owners only", "Clinicians — skip if not prescribing"), a question that \
establishes which segment, role, site or stage the respondent belongs to, or a section whose title \
states when it applies, is STATED routing and may be quoted as a signal.

What still does not count is variety alone: many sections covering many topics is not routing, \
however long the list, and neither is a question simply being skippable in your opinion.

## The document text may be an excerpt

Long documents are given to you as the front, the back, and the passages that use routing \
language, joined in document order. "[…]" marks where text was left out. Never quote across one, \
and never read the two spans either side of one as adjacent or consecutive. Nothing you were not \
given can be evidence either way — say what you found in what you were given.

## Grounding

- When you quote the document, put the exact span in "sourceQuote". When a signal is inferred \
rather than quoted, OMIT "sourceQuote" entirely — never invent one.
- "confidence" reflects how directly the document states this, not how interesting the document is.
- "summary" is one or two sentences: what you found, or why you found nothing.

Output ONLY a single JSON object — no prose, no code fences:
{
  "isCandidate": true | false,
  "confidence": <0 to 1>,
  "signals": [
    { "note": "<why this counts, one short sentence>", "sourceQuote": "<exact span — omit if inferred>" }
  ],
  "summary": "<one or two sentences>"
}`;

export interface ScopeCandidacyPromptInput {
  documentText: string;
  documentFileName?: string;
  /**
   * The section titles the extractor produced, in document order (F17.22 Phase 3).
   *
   * Carried because a role- or segment-shaped instrument states its routing in its TITLES —
   * "Section 6 — franchise owners only" — and those titles may be nowhere near the part of a long
   * document the excerpt could afford to include. They are also the one view of the document that
   * survives a format the parser flattened badly.
   */
  sectionTitles?: string[];
  /** The extracted question wordings, in document order. Same reason as {@link sectionTitles}. */
  questionPrompts?: string[];
}

/** One labelled, numbered block — omitted entirely when the list is empty. */
function structureBlock(label: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `\n\n${label}:\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
}

/**
 * Build the candidacy check prompt: system rubric + a user turn carrying the document text and,
 * when the caller has them, the extracted section titles and question wordings.
 */
export function buildScopeCandidacyPrompt(input: ScopeCandidacyPromptInput): LlmMessage[] {
  const header = input.documentFileName
    ? `SOURCE DOCUMENT (${input.documentFileName}):`
    : 'SOURCE DOCUMENT:';
  const structure =
    structureBlock('EXTRACTED SECTION TITLES', input.sectionTitles ?? []) +
    structureBlock('EXTRACTED QUESTIONS', input.questionPrompts ?? []);
  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: `${header}\n${input.documentText}${structure}` },
  ];
}

/** A stricter retry `user` message when the first response failed validation. */
export function buildScopeCandidacyRetryMessage(): string {
  return (
    'Your previous response did not match the required JSON schema. Respond again with ONLY the ' +
    'JSON object: "isCandidate" (boolean), "confidence" (0 to 1), "signals" (may be empty), and ' +
    '"summary". No prose, no code fences.'
  );
}
