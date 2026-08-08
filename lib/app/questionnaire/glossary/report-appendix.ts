/**
 * Deterministic glossary appendix for the respondent report and PDF exports (P16).
 *
 * Note this is NOT `report/appendix.ts` — that one is an LLM-synthesised *research* appendix on
 * `RespondentReportContent`. This is a straight rendering of what the admin curated, with no model
 * in the loop, so it belongs beside the other deterministic report furniture.
 *
 * A report is read months later by someone who was not in the conversation. Without the glossary
 * they read "their higher self" and supply their own meaning — which is the exact failure the
 * feature exists to prevent, reappearing at the last step.
 *
 * Pure: no Prisma, no React.
 */

import type { GlossaryAppendixView, GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

/** Heading used wherever the appendix renders, so screen, paper and PDF agree. */
export const GLOSSARY_APPENDIX_HEADING = 'Definitions used in this questionnaire';

/**
 * Build the appendix, or `null` when there is nothing to show.
 *
 * `null` rather than an empty view so every call site's guard is one `if (!appendix)` — an empty
 * heading with no entries is worse than no section at all.
 *
 * `enabled` is the caller's `glossaryReportAppendix` config switch. Taking it here rather than at
 * each render site means the on/off decision is made once, in a pure function that is trivially
 * testable, instead of being repeated across the screen, paper and two PDF surfaces.
 */
export function buildGlossaryAppendix(
  entries: readonly GlossaryEntry[],
  enabled = true
): GlossaryAppendixView | null {
  if (!enabled) return null;

  const withDefinitions = entries
    .map((entry) => ({
      term: entry.term,
      definitions: entry.definitions.map((definition) => definition.trim()).filter(Boolean),
    }))
    .filter((entry) => entry.definitions.length > 0);

  if (withDefinitions.length === 0) return null;

  return { heading: GLOSSARY_APPENDIX_HEADING, entries: withDefinitions };
}
