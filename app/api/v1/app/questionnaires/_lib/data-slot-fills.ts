/**
 * Per-session data-slot fill persistence (Data Slots feature) — the abstraction-layer analogue
 * of the F4.4 answer-slot seam (`answer-slots.ts`). Upserts one fill per (session, data slot),
 * keyed by `@@unique([sessionId, dataSlotId])`. Route-local DB seam; the pure core stays
 * Prisma-free.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import type { AnswerProvenance } from '@/lib/app/questionnaire/types';
import type { DataSlotFillHistoryEntry } from '@/lib/app/questionnaire/panel/types';

/**
 * The Prisma surface these helpers need — satisfied by both the global client and a
 * transaction client, so a caller can run a fill write inside its own transaction (e.g. the
 * form-mode reconciliation writes the answer + its data-slot fills atomically).
 */
type DbClient = Prisma.TransactionClient;

/** One fill to persist (already normalised by the extractor). */
export interface DataSlotFillInput {
  value: unknown;
  paraphrase: string;
  confidence: number;
  provenance: AnswerProvenance;
  rationale?: string;
  /**
   * Move-on (Data Slots feature): a best-effort inference recorded when the orchestrator parks the
   * slot after the re-ask cap. Defaults to `false`; a later confident (non-provisional) fill clears
   * it (promotion). Shown in the panel as "provisional · may revisit".
   */
  provisional?: boolean;
}

/** Narrow a stored `refinementHistory` Json column back to the data-slot history entries. */
function asHistory(value: unknown): DataSlotFillHistoryEntry[] {
  return Array.isArray(value) ? (value as DataSlotFillHistoryEntry[]) : [];
}

/**
 * Upsert a session's fill for one data slot — create on first capture, update when a later turn
 * adds to or CORRECTS it (the extractor improves a slot across turns). When the captured `value`
 * actually changes (e.g. "male" → "female"), the prior value/paraphrase/confidence is appended to
 * `refinementHistory` so the panel can show how the answer evolved — the data-slot analogue of the
 * answer-slot refinement trail, but driven by the upsert (data slots have no separate refine pass).
 * Returns the row id (back-stamped with `lastUpdatedTurnId` by `recordTurn`).
 */
export async function upsertDataSlotFill(
  sessionId: string,
  dataSlotId: string,
  fill: DataSlotFillInput,
  client: DbClient = prisma
): Promise<string> {
  const writeBase = {
    value: jsonInput(fill.value),
    paraphrase: fill.paraphrase,
    confidence: fill.confidence,
    provenanceLabel: fill.provenance,
    rationale: fill.rationale ?? null,
    // Move-on: a later confident fill writes `false`, promoting a parked slot back to a real answer.
    provisional: fill.provisional ?? false,
  };

  const existing = await client.appDataSlotFill.findUnique({
    where: { sessionId_dataSlotId: { sessionId, dataSlotId } },
    select: { id: true, value: true, paraphrase: true, confidence: true, refinementHistory: true },
  });

  if (!existing) {
    const row = await client.appDataSlotFill.create({
      data: { sessionId, dataSlotId, ...writeBase },
      select: { id: true },
    });
    return row.id;
  }

  // Append a history entry only when the captured position actually changed — a reworded
  // paraphrase of the same value shouldn't pollute the trail.
  const history = asHistory(existing.refinementHistory);
  const valueChanged = JSON.stringify(existing.value) !== JSON.stringify(fill.value);
  if (valueChanged) {
    history.push({
      previousValue: existing.value,
      previousParaphrase: existing.paraphrase,
      previousConfidence: existing.confidence,
      changedAt: new Date().toISOString(),
    });
  }

  await client.appDataSlotFill.update({
    where: { id: existing.id },
    data: { ...writeBase, refinementHistory: jsonInput(history) },
    select: { id: true },
  });
  return existing.id;
}

/**
 * Clear a session's fill for one data slot (the slot is no longer covered). Idempotent — a
 * missing fill is a no-op. Used by the form-mode reconciliation when every question a slot maps
 * to has been cleared, so the panel reverts the slot to "not covered yet".
 */
export async function clearDataSlotFill(
  sessionId: string,
  dataSlotId: string,
  client: DbClient = prisma
): Promise<void> {
  await client.appDataSlotFill.deleteMany({ where: { sessionId, dataSlotId } });
}
