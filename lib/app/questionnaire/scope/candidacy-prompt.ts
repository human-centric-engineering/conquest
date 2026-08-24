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
}

/** Build the candidacy check prompt: system rubric + a user turn carrying the document text. */
export function buildScopeCandidacyPrompt(input: ScopeCandidacyPromptInput): LlmMessage[] {
  const header = input.documentFileName
    ? `SOURCE DOCUMENT (${input.documentFileName}):`
    : 'SOURCE DOCUMENT:';
  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: `${header}\n${input.documentText}` },
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
