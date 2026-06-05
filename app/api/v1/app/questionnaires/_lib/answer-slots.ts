/**
 * Route-local answer-slot persistence seam (F4.4).
 *
 * The DB write path for refinements. The pure refinement core
 * (`lib/app/questionnaire/refinement/**`) stays Prisma-free; all the I/O for reading
 * an existing answer, seeding one, and writing a refinement back lives here. F4.6
 * reuses this seam for the live per-turn loop (it may be promoted to a shared lib
 * module then).
 *
 * No real respondent sessions exist yet (F4.6/P6), so the refine-answer route
 * exercises the write path against a **preview session**: one per version, reused
 * idempotently and flagged `isPreview` so P8 analytics exclude it. The route seeds
 * the caller-supplied existing answers via {@link upsertAnswerSlot}, then refines
 * them — so the persisted result is observable end-to-end before the engine exists.
 *
 * `refinementHistory` entries are stamped with `createdAt` HERE, at the storage
 * boundary: the pure core has no clock (so replays stay deterministic), so the seam
 * adds the timestamp to any entry that lacks one when it writes.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ANSWER_PROVENANCES, type AnswerProvenance } from '@/lib/app/questionnaire/types';
import type {
  ExistingAnswerView,
  RefinedSlotState,
  RefinementHistoryEntry,
} from '@/lib/app/questionnaire/refinement/types';

/** A loaded answer row plus its id, ready to refine. */
export interface LoadedAnswerSlot {
  /** `AppAnswerSlot.id` — the target of {@link persistRefinement}. */
  id: string;
  /** The current answer, shaped for the pure {@link applyRefinement}. */
  existing: ExistingAnswerView;
}

/** The fields needed to seed an existing answer before refining it. */
export interface SeedAnswerInput {
  value: unknown;
  provenance: AnswerProvenance;
  rationale?: string;
  confidence?: number | null;
  refinementHistory?: RefinementHistoryEntry[];
}

/**
 * Convert an arbitrary JSON value into a Prisma `Json` input — mirrors the
 * ingestion persist helper. `null`/`undefined` map to the DB-null sentinel.
 */
function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value;
}

/** Narrow a stored `provenanceLabel` string to the enum, defaulting to `direct`. */
function asProvenance(value: string): AnswerProvenance {
  return (ANSWER_PROVENANCES as readonly string[]).includes(value)
    ? (value as AnswerProvenance)
    : 'direct';
}

/** Parse a stored `refinementHistory` JSON column into the typed array (our own
 *  data; defensively default a non-array to empty). */
function asHistory(value: Prisma.JsonValue): RefinementHistoryEntry[] {
  return Array.isArray(value) ? (value as unknown as RefinementHistoryEntry[]) : [];
}

/**
 * Get-or-create the single preview session for a version, idempotently. Admin
 * refine-answer exercises reuse one preview session per version so they don't
 * accrete throwaway rows. Returns the session id.
 */
export async function getOrCreatePreviewSession(versionId: string): Promise<string> {
  const existing = await prisma.appQuestionnaireSession.findFirst({
    where: { versionId, isPreview: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.appQuestionnaireSession.create({
    data: { versionId, isPreview: true, status: 'active' },
    select: { id: true },
  });
  return created.id;
}

/**
 * Upsert a captured answer for a slot within a session — the "seed the existing
 * answer first" step the refine-answer route runs before refining. Keyed on the
 * `(sessionId, questionSlotId)` unique. Returns the row id.
 *
 * **`refinementHistory` is written on CREATE only, never on UPDATE.** Refinements own
 * the history (`persistRefinement` appends to it), so re-seeding an answer that has
 * already been refined must NOT reset its accumulated audit trail. Seeding the same
 * answer twice updates the value/provenance but preserves the history a prior pass
 * (or the live engine, F4.6) built up.
 */
export async function upsertAnswerSlot(
  sessionId: string,
  questionSlotId: string,
  answer: SeedAnswerInput
): Promise<string> {
  // Mutable on every seed; history is initialised once (on create) and thereafter
  // owned by persistRefinement.
  const writeBase = {
    value: jsonInput(answer.value),
    provenanceLabel: answer.provenance,
    rationale: answer.rationale ?? null,
    confidence: answer.confidence ?? null,
  };
  const row = await prisma.appAnswerSlot.upsert({
    where: { sessionId_questionSlotId: { sessionId, questionSlotId } },
    create: {
      sessionId,
      questionSlotId,
      ...writeBase,
      refinementHistory: jsonInput(answer.refinementHistory ?? []),
    },
    update: writeBase,
    select: { id: true },
  });
  return row.id;
}

/**
 * Load the answer for a slot within a session, shaped for {@link applyRefinement}.
 * Returns `null` when the slot has no answer in the session.
 */
export async function loadAnswerSlot(
  sessionId: string,
  questionSlotId: string
): Promise<LoadedAnswerSlot | null> {
  const row = await prisma.appAnswerSlot.findUnique({
    where: { sessionId_questionSlotId: { sessionId, questionSlotId } },
    select: {
      id: true,
      questionSlot: { select: { key: true } },
      value: true,
      provenanceLabel: true,
      rationale: true,
      confidence: true,
      refinementHistory: true,
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    existing: {
      slotKey: row.questionSlot.key,
      value: row.value,
      provenance: asProvenance(row.provenanceLabel),
      confidence: row.confidence,
      refinementHistory: asHistory(row.refinementHistory),
      ...(row.rationale != null ? { rationale: row.rationale } : {}),
    },
  };
}

/**
 * Write a refinement back to its row: the new value, the new provenance, and the
 * extended `refinementHistory`. Entries missing a `createdAt` are stamped now (the
 * storage-boundary clock the pure core deliberately lacks).
 */
export async function persistRefinement(rowId: string, refined: RefinedSlotState): Promise<void> {
  const now = new Date().toISOString();
  const stampedHistory = refined.refinementHistory.map((entry) =>
    'createdAt' in entry ? entry : { ...entry, createdAt: now }
  );

  await prisma.appAnswerSlot.update({
    where: { id: rowId },
    data: {
      value: jsonInput(refined.value),
      provenanceLabel: refined.provenance,
      refinementHistory: jsonInput(stampedHistory),
    },
  });
}
