/**
 * The `extraction_verify` provenance row's `detail` — written by ingest, read by the admin.
 *
 * ## Why one module owns both ends
 *
 * The detail object was built inline in BOTH stream routes, identically, and that duplication has
 * already cost something: the commit that added `unattributedPromptCount` fixed only one of the two
 * copies on its first pass. Nothing catches that — the routes are tested separately, and a signal
 * missing from one of them looks exactly like an ingest that had nothing to report.
 *
 * So the writer lives here, and so does the reader ({@link readFidelityDetail}). A field added to
 * one and forgotten in the other is the failure mode that matters for a provenance row: it is
 * written once, months before anyone reads it, and by then the run cannot be repeated.
 *
 * Pure — no Prisma, no server-only imports, no `next/*`. The reader is imported by a client
 * component, so this file must stay in the client bundle's reach.
 */

import type { VerifyCoverage } from '@/lib/app/questionnaire/ingestion/verify-schema';

/** What happened to the questions the critic flagged. Mirrors `FidelityRecord.repairOutcome`. */
export const REPAIR_OUTCOMES = [
  'none_flagged',
  'repaired',
  'repair_failed',
  'skipped_systemic',
  'verifier_unavailable',
] as const;
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number];

/**
 * The fields of the orchestrator's `FidelityRecord` that reach the row, plus the file name.
 *
 * Structural rather than an import of `FidelityRecord` itself: that type lives in the API tier
 * behind `import 'server-only'`, and this module is reachable from the client.
 */
export interface FidelityDetailInput {
  flaggedCount: number;
  totalCount: number;
  repairOutcome: RepairOutcome;
  coverage: VerifyCoverage | null;
  disallowedEditCount: number;
  unattributedPromptKeys: string[];
  fileName: string;
}

/**
 * Build the `detail` blob for the `extraction_verify` run.
 *
 * The three whole-set signals are **omitted when they have nothing to say** — no coverage read, no
 * disallowed edits, no unattributed prompts. That is deliberate and load-bearing for the reader: a
 * present key means something happened, so a clean ingest's row stays short and an admin surface
 * can render "nothing to report" by finding nothing rather than by comparing zeroes.
 *
 * `unattributedPromptCount` is written alongside the keys, derived from `.length` rather than
 * carried separately, because a corpus run reads the count and two fields that can disagree
 * eventually do.
 */
export function buildFidelityDetail(input: FidelityDetailInput): Record<string, unknown> {
  return {
    flaggedCount: input.flaggedCount,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(input.disallowedEditCount > 0 ? { disallowedEditCount: input.disallowedEditCount } : {}),
    ...(input.unattributedPromptKeys.length > 0
      ? {
          unattributedPromptCount: input.unattributedPromptKeys.length,
          unattributedPromptKeys: input.unattributedPromptKeys,
        }
      : {}),
    totalCount: input.totalCount,
    repairOutcome: input.repairOutcome,
    fileName: input.fileName,
  };
}
