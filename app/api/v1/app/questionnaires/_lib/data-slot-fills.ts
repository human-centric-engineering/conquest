/**
 * Per-session data-slot fill persistence (Data Slots feature) — the abstraction-layer analogue
 * of the F4.4 answer-slot seam (`answer-slots.ts`). Upserts one fill per (session, data slot),
 * keyed by `@@unique([sessionId, dataSlotId])`. Route-local DB seam; the pure core stays
 * Prisma-free.
 */

import { prisma } from '@/lib/db/client';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import type { AnswerProvenance } from '@/lib/app/questionnaire/types';

/** One fill to persist (already normalised by the extractor). */
export interface DataSlotFillInput {
  value: unknown;
  paraphrase: string;
  confidence: number;
  provenance: AnswerProvenance;
  rationale?: string;
}

/**
 * Upsert a session's fill for one data slot — create on first capture, overwrite on a later,
 * better fill (the extractor improves a slot across turns). Returns the row id (back-stamped
 * with `lastUpdatedTurnId` by `recordTurn`). Resolves the slot key → id outside (the caller maps).
 */
export async function upsertDataSlotFill(
  sessionId: string,
  dataSlotId: string,
  fill: DataSlotFillInput
): Promise<string> {
  const writeBase = {
    value: jsonInput(fill.value),
    paraphrase: fill.paraphrase,
    confidence: fill.confidence,
    provenanceLabel: fill.provenance,
    rationale: fill.rationale ?? null,
  };
  const row = await prisma.appDataSlotFill.upsert({
    where: { sessionId_dataSlotId: { sessionId, dataSlotId } },
    create: { sessionId, dataSlotId, ...writeBase },
    update: writeBase,
    select: { id: true },
  });
  return row.id;
}
