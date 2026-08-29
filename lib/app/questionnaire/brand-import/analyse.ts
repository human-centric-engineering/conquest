/**
 * Brand import — the screenshot entry point.
 *
 * Measure the palette, ask the analyst which colour plays which role, annotate the pair that has to
 * read against itself, and return the shared result contract. The URL entry point (phase 2) reuses
 * every step below the harvest.
 *
 * The screenshot route exists because we cannot render a website server-side. Playwright is a dev
 * dependency and Chromium on a serverless function is a size-and-cold-start fight we would lose;
 * meanwhile the admin's own browser has already rendered the page perfectly. So when a URL import
 * is blocked — a bot wall, a login, a heavy SPA — the answer is not a better fetcher, it is to ask
 * for the picture the admin can already see. That is why `blockedResult` always points here.
 */

import { logger } from '@/lib/logging';

import {
  analysedResult,
  type BrandImportResult,
  type ColorCandidate,
  type ImportableField,
  type ProposedField,
} from '@/lib/app/questionnaire/brand-import/result';
import { extractPalette } from '@/lib/app/questionnaire/brand-import/palette';
import {
  assignRoles,
  type RoleAssignment,
} from '@/lib/app/questionnaire/brand-import/assign-roles';
import { annotateContrast } from '@/lib/app/questionnaire/brand-import/contrast';

export interface ScreenshotInput {
  buffer: Buffer;
  /** The type the magic-byte check DETECTED, never the one the browser claimed. */
  mediaType: string;
  /** The client this import is for, when the form has one. Threaded through for cost attribution. */
  demoClientId?: string;
}

/**
 * Analyse a screenshot into proposed theme fields.
 *
 * Never throws for an ordinary failure. An undecodable image, an unseeded agent and an unreachable
 * provider all resolve to a result the dialog can render — `empty` with a next step, or the
 * measured palette marked `degraded`. The only thing that reaches the route as an exception is a
 * genuine defect.
 */
export async function analyseScreenshot(input: ScreenshotInput): Promise<BrandImportResult> {
  const candidates = await extractPalette(input.buffer);

  if (candidates.length === 0) {
    return analysedResult({ source: 'screenshot', fields: {}, candidates: [], degraded: false });
  }

  let assignments: RoleAssignment[] = [];
  let sawImage = false;
  let degraded = false;

  try {
    const assigned = await assignRoles({
      candidates,
      demoClientId: input.demoClientId,
      image: { base64: input.buffer.toString('base64'), mediaType: input.mediaType },
    });
    assignments = assigned.assignments;
    sawImage = assigned.sawImage;
  } catch (error) {
    // Expected in a deployment with no provider configured, and after a provider outage. The
    // palette is the expensive part and it is already in hand, so this degrades rather than fails.
    degraded = true;
    logger.info('Brand import: role assignment unavailable, returning the measured palette', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const fields = annotateContrast(
    assignmentsToFields(assignments, {
      confidence: sawImage ? 'high' : 'low',
      source: sawImage
        ? 'read from the screenshot'
        : 'inferred from the screenshot’s palette (no image model available)',
    })
  );

  return analysedResult({
    source: 'screenshot',
    fields,
    candidates,
    degraded,
    note: degraded
      ? 'We measured the colours but could not work out which is which — no AI provider was available. Pick from the palette below.'
      : undefined,
  });
}

/**
 * Turn role assignments into the result's field bag.
 *
 * Shared with the URL path, which assigns the same way over a differently-sourced palette.
 */
export function assignmentsToFields(
  assignments: RoleAssignment[],
  provenance: { confidence: ProposedField['confidence']; source: string }
): Partial<Record<ImportableField, ProposedField>> {
  const fields: Partial<Record<ImportableField, ProposedField>> = {};
  for (const assignment of assignments) {
    fields[assignment.field] = {
      value: assignment.hex,
      confidence: provenance.confidence,
      source: provenance.source,
    };
  }
  return fields;
}

/** Re-exported so the route can render a palette-only answer without reaching past this module. */
export type { ColorCandidate };
