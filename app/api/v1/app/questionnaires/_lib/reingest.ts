/**
 * Re-ingest persistence writer (F2.4).
 *
 * Replaces a **draft** version's extracted graph in place: the route has already
 * run the same parse → extract → coherence pipeline as a fresh ingest
 * (`_lib/extract-pipeline.ts`), and this writes the result over the existing
 * version in **one transaction**. The prior section → slot graph, editorial
 * change log, and tag vocabulary are cleared and rewritten; the version row
 * (id / number / status) is kept, prior source documents are kept, and the new
 * source document is appended.
 *
 * Goal/audience are re-resolved through the admin-wins-per-field merge with the
 * **pre-existing** arm fed the version's current values — so a re-ingest whose new
 * extraction infers no goal/audience never blanks a field the version already had.
 *
 * Mirrors `_lib/persist.ts` (the new-ingest writer) and reuses its `writeGraph` /
 * `writeSourceDocument` helpers; the `lib/app/questionnaire/**` module stays
 * Prisma-free, this `_lib/` file is the DB seam.
 */

import { Prisma } from '@prisma/client';

import { executeTransaction } from '@/lib/db/utils';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import {
  mergeGoalAudience,
  type MergeProvenance,
} from '@/app/api/v1/app/questionnaires/_lib/merge';
import {
  writeGraph,
  writeSourceDocument,
  type IngestionSourceInput,
} from '@/app/api/v1/app/questionnaires/_lib/persist';

/**
 * The version stopped being a `draft` between the route's pre-check and this
 * writer's transaction (a concurrent launch). Thrown inside the transaction so the
 * destructive replace rolls back; the route maps it to the same `409
 * REINGEST_NOT_DRAFT` the outer guard returns. Closes the draft-only TOCTOU.
 */
export class ReingestNotDraftError extends Error {
  constructor(readonly status: string) {
    super(`Version is ${status}; re-ingest requires a draft`);
    this.name = 'ReingestNotDraftError';
  }
}

export interface ReingestVersionInput {
  /** The draft version whose graph is being replaced (validated draft by the route). */
  versionId: string;
  /** The structured, normalised extractor output from the replacement document. */
  extraction: ExtractQuestionnaireStructureData;
  /** Admin-supplied goal/audience from the re-ingest form (admin wins per field). */
  admin: { goal?: string; audience?: Partial<AudienceShape> };
  source: IngestionSourceInput;
}

export interface ReingestVersionResult {
  versionId: string;
  sectionCount: number;
  questionCount: number;
  changeCount: number;
  goal: string | null;
  audience: AudienceShape | null;
  fieldProvenance: MergeProvenance;
}

/**
 * Replace a draft version's extracted graph from a fresh extraction. Assumes the
 * route has validated the version is a `draft` and called `assertPersistable` on
 * the extraction (via the shared pipeline). All-or-nothing.
 */
export async function reingestVersion(input: ReingestVersionInput): Promise<ReingestVersionResult> {
  const { versionId, extraction, admin, source } = input;

  return executeTransaction(async (tx) => {
    // Read the current status + goal/audience inside the tx so the read-then-
    // replace is atomic against a concurrent edit. Re-assert draft-ness here, not
    // just at the route's pre-check: a concurrent launch during the (seconds-long)
    // extraction could otherwise let this destructive replace rewrite a launched
    // version's graph — the very thing the draft-only rule exists to prevent.
    const current = await tx.appQuestionnaireVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { status: true, goal: true, audience: true },
    });
    if (current.status !== 'draft') throw new ReingestNotDraftError(current.status);

    const merged = mergeGoalAudience({
      admin,
      inferred: {
        ...(extraction.inferredGoal !== undefined ? { goal: extraction.inferredGoal } : {}),
        ...(extraction.inferredAudience !== undefined
          ? { audience: extraction.inferredAudience }
          : {}),
      },
      existing: {
        goal: current.goal,
        // Stored audience is our own AudienceShape written on a prior ingest/edit
        // (trusted-internal) — the same cast the version-meta edit route uses.
        audience: (current.audience ?? null) as AudienceShape | null,
      },
    });

    // Clear the prior graph. Order: change log + sections (cascades slots →
    // slot-tag joins) first, then the now-unreferenced tag vocabulary.
    await tx.appQuestionnaireExtractionChange.deleteMany({ where: { versionId } });
    await tx.appQuestionnaireSection.deleteMany({ where: { versionId } });
    await tx.appQuestionTag.deleteMany({ where: { versionId } });

    // Re-resolve goal/audience + provenance onto the kept version row.
    await tx.appQuestionnaireVersion.update({
      where: { id: versionId },
      data: {
        goal: merged.goal,
        audience: merged.audience === null ? Prisma.JsonNull : jsonInput(merged.audience),
        goalProvenance: merged.provenance.goal ?? null,
        audienceProvenance:
          Object.keys(merged.provenance.audience).length > 0
            ? jsonInput(merged.provenance.audience)
            : Prisma.JsonNull,
      },
      select: { id: true },
    });

    const counts = await writeGraph(tx, versionId, extraction);
    await writeSourceDocument(tx, versionId, source);

    return {
      versionId,
      ...counts,
      goal: merged.goal,
      audience: merged.audience,
      fieldProvenance: merged.provenance,
    };
  });
}
