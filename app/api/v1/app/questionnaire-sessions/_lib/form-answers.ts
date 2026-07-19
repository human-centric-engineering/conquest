/**
 * Form-mode answer persistence seam (P-presentation).
 *
 * The DB write path for answers a respondent sets themselves in the raw form surface
 * (chat / form / both). DISTINCT from the refinement-owned seam
 * (`app/api/v1/app/questionnaires/_lib/answer-slots.ts`), which writes the per-turn
 * pipeline's captures and owns the "history on create only" discipline. This seam
 * owns the form's discipline instead:
 *
 *   - **Fresh** (no row yet): create with provenance `direct`, full confidence, no
 *     history. The absence of any history entry = answered fresh in the form.
 *   - **Edit** (row exists, value changes): append ONE {@link RefinementHistoryEntry}
 *     with `source: 'manual'` (preserving the prior value + provenance), set provenance
 *     to `refined`. A `manual` entry whose `previousProvenance` is `inferred`/
 *     `synthesised` is the record that the respondent ADJUSTED an agent-inferred answer.
 *
 * Either way `respondentEdited` is set true — the authoritative guard the per-turn
 * pipeline checks so later extraction/refinement never silently overwrites a
 * respondent's own answer (see `refinement/should-skip-respondent-edited`).
 *
 * `createdAt` is stamped HERE, at the storage boundary (the pure core has no clock),
 * exactly as `persistRefinement` does.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import {
  ANSWER_PROVENANCES,
  narrowToEnum,
  QUESTION_TYPES,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import type { RefinementHistoryEntry } from '@/lib/app/questionnaire/refinement/types';
import {
  upsertDataSlotFill,
  clearDataSlotFill,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-fills';
import { formatSlotAnswer } from '@/lib/app/questionnaire/panel/format-slot-answer';
import { jsonArray, jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

/**
 * Question types whose answer reads meaningfully on its own — free-text prose and the labels of a
 * choice. A likert point, a number, a yes/no, or a date is meaningless in a slot summary without its
 * question ("Not at all" tells a reader nothing), so those are left OUT of the human paraphrase (the
 * structured value is still kept whole in the fill's diffable `value`). The data-slot summary is for
 * conveying meaning, so it shows only what does.
 */
const STANDALONE_MEANINGFUL_TYPES: ReadonlySet<QuestionType> = new Set([
  'free_text',
  'single_choice',
  'multi_choice',
]);

/** Shown when a slot's form answers carry no standalone meaning (all bare scale points / numbers). */
const FORM_DIRECT_PARAPHRASE = 'Form questions were answered directly.';

/** Minimal session shape the PUT route needs: access fields + status + version. */
export interface SessionForFormWrite {
  id: string;
  status: string;
  respondentUserId: string | null;
  versionId: string;
}

/** A version question slot addressed by a form write — what validation needs. */
export interface FormSlot {
  id: string;
  key: string;
  type: QuestionType;
  typeConfig: unknown;
}

/**
 * Load the session fields the form-write route gates on. `null` when the id doesn't
 * resolve (route → 404). Carries `versionId` so the route can resolve question keys
 * and `respondentUserId` + `status` for the access + active-status gates.
 */
export async function loadSessionForFormWrite(
  sessionId: string
): Promise<SessionForFormWrite | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, respondentUserId: true, versionId: true },
  });
  return row;
}

/**
 * Resolve a set of stable question keys to their slots within a version. Returns a
 * map keyed by `key`; missing keys are simply absent (the route rejects the request).
 */
export async function loadVersionSlotsByKey(
  versionId: string,
  keys: string[]
): Promise<Map<string, FormSlot>> {
  const rows = await prisma.appQuestionSlot.findMany({
    where: { versionId, key: { in: keys } },
    select: { id: true, key: true, type: true, typeConfig: true },
  });
  return new Map(
    rows.map((r) => [
      r.key,
      {
        id: r.id,
        key: r.key,
        // Stored `type` is a string column; narrow defensively (free_text fallback).
        type: r.type as QuestionType,
        typeConfig: r.typeConfig,
      },
    ])
  );
}

/** Outcome of one manual write — whether a new answer was created or an existing one edited. */
export type ManualAnswerOutcome = 'created' | 'edited' | 'unchanged';

/**
 * Record a respondent's manual form answer for a slot. `normalisedValue` is the
 * per-type-validated value (the route runs `validateAnswerValue` first). Fresh vs edit
 * is decided from the existing row; an edit appends a `manual` history entry. A re-save
 * of the identical value is a no-op (no history spam) but still marks `respondentEdited`.
 * Runs on the supplied client (the route passes a transaction client).
 */
export async function recordManualAnswer(
  client: Prisma.TransactionClient,
  sessionId: string,
  questionSlotId: string,
  normalisedValue: unknown
): Promise<ManualAnswerOutcome> {
  const existing = await client.appAnswerSlot.findUnique({
    where: { sessionId_questionSlotId: { sessionId, questionSlotId } },
    select: {
      id: true,
      value: true,
      provenanceLabel: true,
      refinementHistory: true,
      respondentEdited: true,
    },
  });

  // Fresh: no prior capture. Create as a direct, fully-confident respondent answer.
  if (!existing) {
    await client.appAnswerSlot.create({
      data: {
        sessionId,
        questionSlotId,
        value: jsonInput(normalisedValue),
        provenanceLabel: 'direct',
        confidence: 1,
        respondentEdited: true,
        refinementHistory: jsonInput([]),
      },
    });
    return 'created';
  }

  // Re-save of the same value: don't append a history entry. Still ensure the slot is
  // marked respondent-edited (a respondent re-affirming an inferred answer makes it theirs).
  const sameValue = JSON.stringify(existing.value) === JSON.stringify(normalisedValue);
  if (sameValue) {
    if (!existing.respondentEdited) {
      await client.appAnswerSlot.update({
        where: { id: existing.id },
        data: { respondentEdited: true },
      });
    }
    return 'unchanged';
  }

  // Edit: append a manual history entry preserving the prior value/provenance, then write
  // the new value with provenance `refined` (the answer genuinely evolved by the respondent).
  const previousProvenance = narrowToEnum(existing.provenanceLabel, ANSWER_PROVENANCES, 'direct');
  const entry: RefinementHistoryEntry & { createdAt: string } = {
    previousValue: existing.value,
    previousProvenance,
    newValue: normalisedValue,
    rationale: 'Edited in form view',
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  const history = [...jsonArray<RefinementHistoryEntry>(existing.refinementHistory), entry];

  await client.appAnswerSlot.update({
    where: { id: existing.id },
    data: {
      value: jsonInput(normalisedValue),
      provenanceLabel: 'refined',
      confidence: 1,
      respondentEdited: true,
      refinementHistory: jsonInput(history),
    },
  });
  return 'edited';
}

/**
 * Clear a respondent's answer for a slot (form "unset"). Deletes the row — absence,
 * not a null value, is how "unanswered" is represented everywhere. Idempotent: a
 * missing row is a no-op.
 */
export async function clearAnswer(
  client: Prisma.TransactionClient,
  sessionId: string,
  questionSlotId: string
): Promise<void> {
  await client.appAnswerSlot.deleteMany({
    where: { sessionId, questionSlotId },
  });
}

/**
 * Reconcile the data-slot fills affected by a set of just-written question edits (P-presentation).
 *
 * Data slots are the chat-facing abstraction over questions (M:N via `AppDataSlotQuestion`); the
 * form edits the underlying questions directly. So after a form write, recompute each data slot
 * that maps to an edited question from the session's CURRENT answers to ALL its mapped questions:
 *
 *  - some mapped questions answered → upsert the fill with a deterministic paraphrase (joined
 *    formatted values), `direct` provenance, full confidence, non-provisional — so the chat panel
 *    reflects the respondent's edit immediately (not just on the next chat turn).
 *  - none answered (all cleared) → clear the fill, so the slot reverts to "not covered yet".
 *
 * Runs on the form-write transaction client so the answer + its fills commit atomically. A no-op
 * when the version has no data slots (the mapping query returns empty).
 */
export async function reconcileDataSlotFills(
  client: Prisma.TransactionClient,
  sessionId: string,
  editedQuestionSlotIds: string[]
): Promise<void> {
  if (editedQuestionSlotIds.length === 0) return;

  // Which data slots does any edited question feed?
  const links = await client.appDataSlotQuestion.findMany({
    where: { questionSlotId: { in: editedQuestionSlotIds } },
    select: { dataSlotId: true },
  });
  const dataSlotIds = [...new Set(links.map((l) => l.dataSlotId))];

  for (const dataSlotId of dataSlotIds) {
    // All questions this slot maps to (a slot can cover several), and the session's answers to them.
    // `type` + `typeConfig` come along so the paraphrase renders each answer's human-readable label
    // (a likert "1" → "Not at all", a choice key → its option label) rather than a bare value.
    const mapped = await client.appDataSlotQuestion.findMany({
      where: { dataSlotId },
      select: { questionSlot: { select: { id: true, key: true, type: true, typeConfig: true } } },
    });
    const mappedIds = mapped.map((m) => m.questionSlot.id);
    const answers = await client.appAnswerSlot.findMany({
      where: { sessionId, questionSlotId: { in: mappedIds } },
      select: { questionSlotId: true, value: true },
    });
    const valueByQid = new Map(answers.map((a) => [a.questionSlotId, a.value]));

    const answered = mapped
      .filter((m) => valueByQid.has(m.questionSlot.id))
      .map((m) => ({
        key: m.questionSlot.key,
        type: narrowToEnum(m.questionSlot.type, QUESTION_TYPES, 'free_text'),
        typeConfig: m.questionSlot.typeConfig,
        value: valueByQid.get(m.questionSlot.id),
      }));

    if (answered.length === 0) {
      await clearDataSlotFill(sessionId, dataSlotId, client);
      continue;
    }

    // Structured, diffable value (keyed by question) drives the fill's change-history. The
    // paraphrase is the human summary the panel shows, so it's built only from answers that read on
    // their own (free-text + choice labels); bare scale points / numbers are excluded as meaningless
    // out of context. When nothing meaningful remains, say so plainly rather than dumping values.
    const value = Object.fromEntries(answered.map((a) => [a.key, a.value]));
    const semanticParts = answered
      .filter((a) => STANDALONE_MEANINGFUL_TYPES.has(a.type))
      .map((a) => formatSlotAnswer(a.type, a.typeConfig, a.value))
      .filter((s) => s && s !== '—');
    const paraphrase = semanticParts.length > 0 ? semanticParts.join('; ') : FORM_DIRECT_PARAPHRASE;

    await upsertDataSlotFill(
      sessionId,
      dataSlotId,
      { value, paraphrase, confidence: 1, provenance: 'direct', provisional: false },
      client
    );
  }
}
