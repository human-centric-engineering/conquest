/**
 * Per-session data-slot fill persistence (Data Slots feature) — the abstraction-layer analogue
 * of the F4.4 answer-slot seam (`answer-slots.ts`). Upserts one fill per (session, data slot),
 * keyed by `@@unique([sessionId, dataSlotId])`. Route-local DB seam; the pure core stays
 * Prisma-free.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
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
 * A canonical string for change-detection: object keys sorted recursively and string leaves trimmed.
 * The extractor re-emits a slot's fill every turn as a "superset" of the prior value (see the
 * extraction prompt's RE-SCAN rule), so a re-emit that only reorders keys or adds/strips whitespace
 * must NOT read as a changed value — otherwise it appends a spurious "How this answer evolved"
 * revision and re-flashes the slot as recently-updated when nothing tangible changed. Arrays stay
 * order-sensitive — element order can carry meaning (e.g. a ranked list) — and types are not coerced
 * (`5` ≠ `"5"`), so genuine changes are still detected.
 */
function canonicalValueKey(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = normalize(obj[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

/**
 * The outcome of an {@link upsertDataSlotFill}. `changed` is true on first capture and whenever the
 * write MATERIALLY altered the slot — the captured `value` (compared canonically) or its
 * `provisional` state. A pure re-statement (reworded paraphrase/rationale, key reorder) or a soft
 * confidence nudge from corroboration leaves `changed` false, so the caller can skip stamping
 * `lastUpdatedTurnId` and avoid re-flashing the slot. The fill row is still updated either way.
 */
export interface UpsertDataSlotFillResult {
  id: string;
  changed: boolean;
}

/**
 * Upsert a session's fill for one data slot — create on first capture, update when a later turn
 * adds to or CORRECTS it (the extractor improves a slot across turns). When the captured `value`
 * actually changes (e.g. "male" → "female"), the prior value/paraphrase/confidence is appended to
 * `refinementHistory` so the panel can show how the answer evolved — the data-slot analogue of the
 * answer-slot refinement trail, but driven by the upsert (data slots have no separate refine pass).
 * Returns the row id plus a `changed` flag (see {@link UpsertDataSlotFillResult}) so the caller only
 * back-stamps `lastUpdatedTurnId` — which drives the panel's "recently updated" flash — for fills
 * that materially changed this turn, not every re-emit.
 */
export async function upsertDataSlotFill(
  sessionId: string,
  dataSlotId: string,
  fill: DataSlotFillInput,
  client: DbClient = prisma
): Promise<UpsertDataSlotFillResult> {
  const provisional = fill.provisional ?? false;
  const writeBase = {
    value: jsonInput(fill.value),
    paraphrase: fill.paraphrase,
    confidence: fill.confidence,
    provenanceLabel: fill.provenance,
    rationale: fill.rationale ?? null,
    // Move-on: a later confident fill writes `false`, promoting a parked slot back to a real answer.
    provisional,
  };

  const existing = await client.appDataSlotFill.findUnique({
    where: { sessionId_dataSlotId: { sessionId, dataSlotId } },
    select: {
      id: true,
      value: true,
      paraphrase: true,
      confidence: true,
      rationale: true,
      provisional: true,
      refinementHistory: true,
    },
  });

  if (!existing) {
    const row = await client.appDataSlotFill.create({
      data: { sessionId, dataSlotId, ...writeBase },
      select: { id: true },
    });
    return { id: row.id, changed: true };
  }

  // What MATERIALLY changed: the captured position (value, compared canonically so a reworded /
  // reordered re-emit of the same data doesn't count) or its provisional state. A soft confidence
  // nudge or a reworded paraphrase alone is not a material change — it neither appends a history
  // revision nor re-flashes the slot.
  const valueChanged = canonicalValueKey(existing.value) !== canonicalValueKey(fill.value);
  const provisionalChanged = existing.provisional !== provisional;
  const changed = valueChanged || provisionalChanged;

  // Append a history entry only when the captured value actually changed — a reworded paraphrase of
  // the same value (or a bare provisional flip) shouldn't pollute the "how this answer evolved" trail.
  const history = asHistory(existing.refinementHistory);
  if (valueChanged) {
    history.push({
      previousValue: existing.value,
      previousParaphrase: existing.paraphrase,
      previousConfidence: existing.confidence,
      previousRationale: existing.rationale,
      changedAt: new Date().toISOString(),
    });
  }

  await client.appDataSlotFill.update({
    where: { id: existing.id },
    data: { ...writeBase, refinementHistory: jsonInput(history) },
    select: { id: true },
  });
  return { id: existing.id, changed };
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

/**
 * Deterministic, panel-facing restatement of one answered value (no LLM). Shared by the form-mode
 * reconciler (`form-answers.ts`) and the chat-mode gap-filler ({@link reconcileChatDataSlotFills}).
 */
export function formatFillValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value))
    return value
      .map((v) => formatFillValue(v))
      .filter(Boolean)
      .join(', ');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value).trim();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Chat-mode data-slot reconciliation (gap-filler).
 *
 * The extractor emits per-question answers AND per-data-slot fills in ONE call, and the prompt asks
 * it to keep the two in sync. But a generation miss can answer a mapped question while leaving its
 * PARENT data slot empty — the panel then shows no inferred comment for a topic the respondent
 * clearly addressed (e.g. "badly thought out KPIs" answers `performance_kpis` but its slot
 * `business_execution` stays blank). The form surface already closes the analogous gap
 * deterministically (`reconcileDataSlotFills`); chat had no such safety net. This is it.
 *
 * GAP-FILLING, not overwriting: only synthesises a fill for a data slot that has NO fill yet AND a
 * mapped question answered this session. It never touches a slot that already holds a fill — whether
 * the extractor wrote it THIS turn (its fills are persisted before this runs) or it was captured on an
 * earlier turn. Overwriting would clobber the extractor's richer natural-language paraphrase, or a
 * prior respondent-stated `direct` capture, and downgrade its provenance — evolving a NON-empty slot
 * is the extractor's job, not ours. The synthesised paraphrase leads with each contributing answer's
 * stored `rationale` — already a natural-language restatement — falling back to the formatted value,
 * so it reads like a real inferred comment without a second LLM call. Unlike the form reconciler it
 * never CLEARS a slot (the extractor owns deletions).
 *
 * Returns the `AppDataSlotFill` row ids it wrote, so the caller can stamp them with `lastUpdatedTurnId`.
 */
export async function reconcileChatDataSlotFills(opts: {
  sessionId: string;
  /** Question slot ids written by extraction/refinement this turn (the answers to propagate up). */
  answeredQuestionSlotIds: string[];
  client?: DbClient;
}): Promise<string[]> {
  const client = opts.client ?? prisma;
  if (opts.answeredQuestionSlotIds.length === 0) return [];

  // Which data slots do this turn's answered questions feed?
  const links = await client.appDataSlotQuestion.findMany({
    where: { questionSlotId: { in: opts.answeredQuestionSlotIds } },
    select: { dataSlotId: true, dataSlot: { select: { key: true } } },
  });
  const keyById = new Map(links.map((l) => [l.dataSlotId, l.dataSlot.key]));
  const candidateIds = [...new Set(links.map((l) => l.dataSlotId))];
  if (candidateIds.length === 0) return [];

  // GAP-FILL ONLY: drop any candidate that already has a fill (the extractor's this-turn write is
  // already persisted, so this also covers slots the LLM just filled). We never overwrite an existing
  // fill — that would clobber a richer paraphrase or a respondent-stated `direct` capture.
  const existing = await client.appDataSlotFill.findMany({
    where: { sessionId: opts.sessionId, dataSlotId: { in: candidateIds } },
    select: { dataSlotId: true },
  });
  const filled = new Set(existing.map((e) => e.dataSlotId));
  const dataSlotIds = candidateIds.filter((id) => !filled.has(id));
  if (dataSlotIds.length === 0) return [];

  const writtenIds: string[] = [];
  const reconciledKeys: string[] = [];

  for (const dataSlotId of dataSlotIds) {
    // All questions this slot maps to (a slot can cover several), and the session's CURRENT answers.
    const mapped = await client.appDataSlotQuestion.findMany({
      where: { dataSlotId },
      select: { questionSlot: { select: { id: true, key: true } } },
    });
    const mappedIds = mapped.map((m) => m.questionSlot.id);
    const answers = await client.appAnswerSlot.findMany({
      where: { sessionId: opts.sessionId, questionSlotId: { in: mappedIds } },
      select: { questionSlotId: true, value: true, rationale: true, confidence: true },
    });
    const byQid = new Map(answers.map((a) => [a.questionSlotId, a]));

    const answered = mapped
      .map((m) => ({ key: m.questionSlot.key, answer: byQid.get(m.questionSlot.id) }))
      .filter(
        (m): m is { key: string; answer: NonNullable<(typeof m)['answer']> } =>
          m.answer !== undefined
      );

    // We only reached here because a mapped question was answered this turn, so this is ~always ≥1.
    // Guard anyway: never write an empty fill, and (unlike form mode) never clear — extraction owns that.
    if (answered.length === 0) continue;

    // Structured, diffable value (keyed by question) drives the fill's change-history; the paraphrase
    // leads with each answer's natural-language rationale, falling back to the formatted value.
    const value = Object.fromEntries(answered.map((a) => [a.key, a.answer.value]));
    const paraphrase = answered
      .map((a) => {
        const formatted = formatFillValue(a.answer.value);
        const rationale = (a.answer.rationale ?? '').trim();
        if (formatted && rationale) return `${formatted} — ${rationale}`;
        return rationale || formatted;
      })
      .filter(Boolean)
      .join('; ');
    const confidence = Math.max(...answered.map((a) => a.answer.confidence ?? 0.5));

    // Gap-fill only reaches slots with no existing fill, so this is always a fresh create
    // (`changed === true`); we keep the id to stamp + flash it as genuinely newly captured.
    const { id } = await upsertDataSlotFill(
      opts.sessionId,
      dataSlotId,
      {
        value,
        paraphrase,
        confidence,
        // Derived from the underlying answer(s): "inferred" when one mapped question fixes the slot,
        // "synthesised" when it rolls up several. Never "direct" — the respondent didn't state the fill.
        provenance: answered.length === 1 ? 'inferred' : 'synthesised',
        provisional: false,
      },
      client
    );
    writtenIds.push(id);
    reconciledKeys.push(keyById.get(dataSlotId) ?? dataSlotId);
  }

  if (reconciledKeys.length > 0) {
    // An invariant breach worth surfacing: extraction answered a mapped question but left its data
    // slot empty. Frequency here measures how often the prompt rule misses (and whether it needs work).
    logger.warn(
      'questionnaire: extraction answered a mapped question but left its data slot empty; reconciled deterministically',
      { sessionId: opts.sessionId, dataSlotKeys: reconciledKeys }
    );
  }
  return writtenIds;
}
