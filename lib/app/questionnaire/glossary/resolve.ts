/**
 * Resolve a version's live glossary for the surfaces that consume it (P16).
 *
 * "Live" means the curation gate has been passed: `accepted` terms carrying at least one SELECTED
 * definition. Proposals and rejections never reach a prompt, a respondent, or a report.
 *
 * Server-only — this is the one module in `glossary/` that touches Prisma, and it is deliberately
 * NOT re-exported from the barrel: a client component importing the matcher through the barrel
 * would otherwise drag `@/lib/db/client` into the browser bundle. Import it by path.
 *
 * Both entry points return the same narrow {@link GlossaryEntry} shape the matcher consumes, and
 * both return `[]` when their config switch is off — so callers treat "disabled" and "nothing
 * defined" identically and stay free of feature flags.
 */

import { cache } from 'react';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

import { normalizeGlossarySurface } from '@/lib/app/questionnaire/glossary/normalize';
import { buildGlossaryAppendix } from '@/lib/app/questionnaire/glossary/report-appendix';
import type { GlossaryAppendixView, GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

/** Which switch gates a read. Config is 1:1 and lazy, so an absent row means the defaults. */
type GlossaryGate =
  'glossaryPromptInjection' | 'glossaryRespondentHints' | 'glossaryReportAppendix';

/** `null` = read the accepted set with no config gate (the export surfaces — see below). */
type GlossaryGateOrNone = GlossaryGate | null;

/** Read the `aliases` JSON column as a string array, degrading to none rather than throwing. */
function readAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Load the version's live glossary, or `[]` when `gate` is off.
 *
 * One indexed query (`app_glossary_term_versionId_status_idx`) plus the config row, `cache()`d so
 * the surfaces that read the SAME glossary through DIFFERENT gates — the respondent's inline hints
 * and the report appendix render on one page load — share it instead of each pulling the whole
 * term/definition tree. That is also why all three gate columns are selected up front: the gate is
 * applied here as a projection, so it can vary per caller without varying the query.
 *
 * Definitions are filtered to the selected ones in SQL, so a term whose readings were all unticked
 * comes back with none and is dropped here — it must never underline with an empty popover.
 *
 * `surfaces` is assembled and normalised once, server-side: the client receives ready-to-index
 * strings rather than re-deriving them per render.
 *
 * DELIBERATELY NOT folded into `loadVersionSurface`: this read is best-effort (see
 * {@link loadGlossary}), and a page's primary row must not inherit a fail-soft contract.
 */
const loadGlossaryRow = cache(async (versionId: string) => {
  return prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      config: {
        select: {
          glossaryPromptInjection: true,
          glossaryRespondentHints: true,
          glossaryReportAppendix: true,
        },
      },
      glossaryTerms: {
        where: { status: 'accepted' },
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          term: true,
          aliases: true,
          definitions: {
            where: { selected: true },
            orderBy: { ordinal: 'asc' },
            select: { text: true },
          },
        },
      },
    },
  });
});

async function loadGlossary(versionId: string, gate: GlossaryGateOrNone): Promise<GlossaryEntry[]> {
  try {
    return await queryGlossary(versionId, gate);
  } catch (err) {
    // BEST-EFFORT BY DESIGN. The glossary enriches a turn; it does not enable one. A failure here
    // must degrade to "no definitions this turn", never break the respondent's conversation or the
    // report that follows — the same contract the data-slot cohesion measurement follows.
    logger.warn('Glossary unavailable for this version; continuing without definitions', {
      versionId,
      gate: gate ?? 'none',
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function queryGlossary(
  versionId: string,
  gate: GlossaryGateOrNone
): Promise<GlossaryEntry[]> {
  const version = await loadGlossaryRow(versionId);
  if (!version) return [];

  if (gate) {
    // Config is 1:1 and lazy — an absent row means the documented default for this gate.
    const enabled = version.config?.[gate] ?? DEFAULT_QUESTIONNAIRE_CONFIG[gate];
    if (!enabled) return [];
  }

  return version.glossaryTerms
    .filter((term) => term.definitions.length > 0)
    .map((term) => ({
      termId: term.id,
      term: term.term,
      surfaces: [
        ...new Set(
          [term.term, ...readAliases(term.aliases)]
            .map(normalizeGlossarySurface)
            .filter((surface) => surface.length > 0)
        ),
      ],
      definitions: term.definitions.map((definition) => definition.text),
    }));
}

/**
 * The version's accepted glossary with NO config gate.
 *
 * For the EXPORT surfaces, whose gating is not `glossaryPromptInjection`:
 *   - the blank instrument always carries the glossary (it is the reviewer's copy);
 *   - the respondent's report PDF is gated on `glossaryReportAppendix`, applied by
 *     `buildGlossaryAppendix`'s `enabled` argument at the call site.
 *
 * Reading those through `resolveGlossaryForPrompts` would gate them on the wrong switch: an admin
 * who turned prompt injection off would silently lose the glossary from the instrument, and the
 * report PDF would disagree with the on-screen appendix — the one thing the shared
 * `buildGlossaryAppendix` exists to prevent.
 */
export function loadAcceptedGlossaryEntries(versionId: string): Promise<GlossaryEntry[]> {
  return loadGlossary(versionId, null);
}

/**
 * The glossary for PROMPT injection — the interviewer, extraction, refinement, contradiction and
 * report seams. `[]` when `glossaryPromptInjection` is off or nothing is accepted.
 */
export function resolveGlossaryForPrompts(versionId: string): Promise<GlossaryEntry[]> {
  return loadGlossary(versionId, 'glossaryPromptInjection');
}

/**
 * The glossary for RESPONDENT hints — the chat underline/popover and form labels. `[]` when
 * `glossaryRespondentHints` is off or nothing is accepted, so the client needs no flag of its own.
 */
export function resolveGlossaryForHints(versionId: string): Promise<GlossaryEntry[]> {
  return loadGlossary(versionId, 'glossaryRespondentHints');
}

/**
 * The glossary APPENDIX for the respondent's completion screen — the on-screen twin of the PDF's.
 *
 * `null` when `glossaryReportAppendix` is off or nothing is accepted. Gated by its own switch,
 * separately from the inline hints: an admin can reasonably want definitions available during the
 * conversation but not appended to the delivered report, or the reverse.
 */
export async function resolveGlossaryAppendixForVersion(
  versionId: string
): Promise<GlossaryAppendixView | null> {
  return buildGlossaryAppendix(await loadGlossary(versionId, 'glossaryReportAppendix'));
}
