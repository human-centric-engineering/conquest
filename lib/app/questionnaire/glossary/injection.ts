/**
 * Glossary prompt injection (P16) — selecting and formatting the definitions an agent needs.
 *
 * Modelled line-for-line on `rounds/briefing.ts`, including its cardinal contract: empty input
 * yields `[]`, so the `section()` helper collapses the whole block to nothing and a version with
 * no relevant terms costs zero tokens.
 *
 * The selection is deliberately RELEVANCE-FILTERED rather than "send everything accepted". The
 * interviewer's phraser prompt is a couple of hundred tokens; folding a 60-term glossary into it
 * would crowd out the question itself and make the model's job harder, not easier. So a term is
 * sent only when it actually appears in what this turn is about — using the same matcher the
 * respondent hints use, so the agent is briefed on exactly the terms the respondent can see.
 *
 * Pure (no Prisma / Next), so it is unit-testable and shared by every prompt seam.
 */

import { matchingGlossaryEntries } from '@/lib/app/questionnaire/glossary/matcher';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

/** Hard cap on injected terms — protects the short phraser prompt's token budget. */
export const GLOSSARY_MAX_TERMS = 8;

/** Per-definition cap (chars) before truncation — keeps one long definition from dominating. */
export const GLOSSARY_MAX_DEFINITION_CHARS = 280;

/**
 * The instruction that accompanies the injected terms.
 *
 * Three things it must do, each learned from a way this goes wrong without it:
 *   - stop the agent reciting definitions at the respondent (it reads as lecturing);
 *   - stop it collapsing multiple senses into one when the admin deliberately kept both;
 *   - tell it what to do when the reading actually matters — ask, rather than guess.
 */
export const GLOSSARY_PROMPT_PREAMBLE =
  'Terms this questionnaire uses in a specific sense. Interpret them this way. Do NOT read these ' +
  'definitions out, quote them, or lecture the respondent about them. Where a term lists more ' +
  'than one numbered definition, those are alternative readings this questionnaire accepts — do ' +
  'not collapse them into one; if which reading the respondent means would actually change their ' +
  'answer, ask.';

/** Truncate to `max` chars on a word boundary where possible, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/**
 * Render one term as a single prompt line.
 *
 * A single definition reads as prose; several are numbered `(1) … (2) …` so the model can refer to
 * "the second sense" and so the numbering matches what the respondent sees in the popover.
 */
function formatTermLine(entry: GlossaryEntry): string {
  const definitions = entry.definitions
    .map((definition) => truncate(definition, GLOSSARY_MAX_DEFINITION_CHARS))
    .filter((definition) => definition.length > 0);
  if (definitions.length === 0) return '';
  if (definitions.length === 1) return `- ${entry.term}: ${definitions[0]}`;
  const numbered = definitions.map((definition, i) => `(${i + 1}) ${definition}`).join('; ');
  return `- ${entry.term}: ${numbered}`;
}

/**
 * Select + format the glossary lines relevant to THIS turn.
 *
 * A term is kept when any of its surfaces occurs in `haystack` — the caller passes whatever the
 * turn is about (the asked question, its guidance, the recent transcript, the candidate answers).
 * Caps at {@link GLOSSARY_MAX_TERMS} in the order given (the caller orders by ordinal). Returns
 * `[]` when nothing applies, so the prompt section collapses to nothing.
 */
export function selectGlossaryLines(
  entries: readonly GlossaryEntry[],
  haystack: readonly string[]
): string[] {
  if (entries.length === 0) return [];
  return matchingGlossaryEntries(entries, haystack)
    .slice(0, GLOSSARY_MAX_TERMS)
    .map(formatTermLine)
    .filter((line) => line.length > 0);
}

/**
 * Format the whole accepted set — no relevance filter and NO CAP — for the surfaces that run once
 * over a whole session rather than per turn (report generation).
 *
 * Deliberately uncapped. `GLOSSARY_MAX_TERMS` exists to protect the ~220-token phraser prompt on
 * every turn; applying it here silently gave the report writer 8 of up to 60 terms while
 * `buildGlossaryAppendix` printed all 60 in the appendix — so a reader saw definitions the prose
 * had been written without. One call per session can afford the whole vocabulary, which is the
 * entire reason this function exists separately from {@link selectGlossaryLines}.
 *
 * The upper bound is `GLOSSARY_MAX_TERMS_PER_VERSION` (60), enforced at the save boundary.
 */
export function allGlossaryLines(entries: readonly GlossaryEntry[]): string[] {
  return entries.map(formatTermLine).filter((line) => line.length > 0);
}

/**
 * Assemble the body of a `<glossary>` prompt section: the preamble plus one line per term.
 *
 * Returns `''` for no lines, so `section('glossary', formatGlossarySection([]))` collapses to
 * nothing — the zero-cost-when-absent contract every caller relies on.
 */
export function formatGlossarySection(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return `${GLOSSARY_PROMPT_PREAMBLE}\n\n${lines.join('\n')}`;
}
