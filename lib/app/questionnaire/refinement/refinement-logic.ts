/**
 * Refinement normalisation + the pure value-merge (F4.4).
 *
 * Three pure, data-in / data-out exports, no Prisma / Next:
 *
 *  1. {@link normalizeRefinementDecisions} — the F4.4 analogue of F4.2's
 *     `normalizeAnswerIntents`. Takes the LLM-reported decisions (already
 *     schema-valid) plus the {@link RefinementContext} and returns the coherent
 *     {@link RefinementDecision}s to apply, dropping an individual odd decision
 *     rather than failing the whole pass. Jobs:
 *       - Resolve every `slotKey` to a real slot AND an *already-answered* one (you
 *         can't refine an unanswered slot) — else drop.
 *       - Filter out `leave` (a deliberate non-change, not an error).
 *       - Require a `newValue` for refine/overwrite, and validate it against the
 *         slot's real type/config (reusing F4.2's `validateAnswerValue`) — else drop
 *         (don't fabricate a no-op the model didn't intend).
 *       - Drop a no-op (the validated new value equals the existing one) — don't
 *         churn history with an identical entry.
 *       - De-duplicate per slot: keep the highest-confidence decision (stable tie).
 *
 *  2. {@link applyRefinement} — the deterministic value-merge. Given an existing
 *     answer and a decision, returns the new in-memory slot state: value updated,
 *     `refinementHistory` extended with a pre-change snapshot, and provenance set to
 *     `refined` **only** for `refine` (an `overwrite` keeps the original label — a
 *     typo fix is not an evolution). This is the "refinementHistory write path"
 *     realized as pure logic; the route's `_lib` seam wires it to a Prisma write.
 *
 *  3. {@link summarizeRefinements} — the counts-only roll-up shared by the route's
 *     `summary` and the capability's PII-safe redaction preview.
 */

import { validateAnswerValue } from '@/lib/app/questionnaire/extraction/answer-value';
import type { RefinementDecisionRaw } from '@/lib/app/questionnaire/refinement/refinement-schema';
import {
  type DroppedRefinement,
  type ExistingAnswerView,
  type RefinedSlotState,
  type RefinementContext,
  type RefinementDecision,
  type RefinementHistoryEntry,
  type RefinementResult,
  type RefinementSummary,
} from '@/lib/app/questionnaire/refinement/types';

/**
 * Structural value equality for no-op detection. Values reaching here are the
 * normalised forms `validateAnswerValue` returns (trimmed strings, parsed numbers,
 * deduped string arrays) and the existing recorded value, so a stable JSON
 * comparison is sufficient and deterministic. Order-insensitive for arrays so a
 * multi_choice re-stated in a different order counts as a no-op.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    const sa = arrA.map((v) => JSON.stringify(v)).sort();
    const sb = arrB.map((v) => JSON.stringify(v)).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Normalise the refiner's reported decisions against the context. See the module
 * doc. Returns the coherent decisions to apply plus the records removed (with
 * reasons) for logging.
 */
export function normalizeRefinementDecisions(
  refinements: RefinementDecisionRaw[],
  ctx: RefinementContext
): RefinementResult {
  const dropped: DroppedRefinement[] = [];
  const slotByKey = new Map(ctx.slots.map((s) => [s.key, s]));
  const answerByKey = new Map(ctx.existingAnswers.map((a) => [a.slotKey, a]));

  // First pass: resolve + validate into candidate decisions.
  const candidates: RefinementDecision[] = [];
  for (const r of refinements) {
    // `leave` is a deliberate non-change — not an error, just nothing to apply.
    if (r.action === 'leave') continue;

    const slot = slotByKey.get(r.slotKey);
    if (!slot) {
      dropped.push({ slotKey: r.slotKey, reason: 'unknown slot key' });
      continue;
    }

    const existing = answerByKey.get(r.slotKey);
    if (!existing) {
      dropped.push({ slotKey: r.slotKey, reason: 'slot is not already answered' });
      continue;
    }

    // refine/overwrite must carry a value to write.
    if (r.newValue === undefined) {
      dropped.push({ slotKey: r.slotKey, reason: `${r.action} without a newValue` });
      continue;
    }

    // The new value must be a legal answer for the slot's real type/config.
    const validation = validateAnswerValue(slot.type, r.newValue, slot.typeConfig);
    if (!validation.ok) {
      dropped.push({ slotKey: r.slotKey, reason: `value fails type: ${validation.issue}` });
      continue;
    }

    // Don't record a refinement that changes nothing.
    if (valuesEqual(validation.value, existing.value)) {
      dropped.push({ slotKey: r.slotKey, reason: 'no-op: new value equals existing value' });
      continue;
    }

    candidates.push({
      slotKey: r.slotKey,
      action: r.action,
      questionType: slot.type,
      newValue: validation.value,
      rationale: r.rationale,
      source: r.source,
      confidence: r.confidence,
    });
  }

  // Second pass: de-duplicate per slot, keeping the highest confidence. Higher
  // confidence wins; an exact tie keeps the first seen (stable).
  const best = new Map<string, RefinementDecision>();
  for (const decision of candidates) {
    const incumbent = best.get(decision.slotKey);
    if (!incumbent) {
      best.set(decision.slotKey, decision);
      continue;
    }
    if (decision.confidence > incumbent.confidence) {
      best.set(decision.slotKey, decision);
      dropped.push({ slotKey: incumbent.slotKey, reason: 'duplicate decision, lower confidence' });
    } else {
      dropped.push({ slotKey: decision.slotKey, reason: 'duplicate decision, lower confidence' });
    }
  }

  return { decisions: [...best.values()], dropped };
}

/**
 * Apply one decision to an existing answer, producing the new in-memory slot state.
 * Never mutates `existing`. Builds the history entry from the *pre-change* state and
 * appends it; sets provenance to `refined` **only** for a `refine` (an `overwrite`
 * keeps the original label — a mistaken capture being fixed is not an evolution).
 */
export function applyRefinement(
  existing: ExistingAnswerView,
  decision: RefinementDecision
): RefinedSlotState {
  const entry: RefinementHistoryEntry = {
    previousValue: existing.value,
    previousProvenance: existing.provenance,
    newValue: decision.newValue,
    rationale: decision.rationale,
    source: decision.source,
    // Carry the turn the prior value was captured on when the caller supplied it
    // (the real turn loop, F4.6); absent on the hand-driven path.
    ...(existing.turnIndex !== undefined ? { turnIndex: existing.turnIndex } : {}),
    // Record the confidence trajectory so the trail shows the score evolving across turns,
    // not just the value. Prior score only when it was scored; new score is the decision's.
    ...(existing.confidence !== undefined ? { previousConfidence: existing.confidence } : {}),
    newConfidence: decision.confidence,
  };

  return {
    slotKey: existing.slotKey,
    value: decision.newValue,
    provenance: decision.action === 'refine' ? 'refined' : existing.provenance,
    // The new value carries the refiner's certainty — refining is allowed to improve
    // (or lower) the slot's confidence, not freeze it at the original capture's score.
    confidence: decision.confidence,
    refinementHistory: [...(existing.refinementHistory ?? []), entry],
  };
}

/**
 * Roll a decision list up into the counts-only {@link RefinementSummary} — the
 * single source of truth for both the preview route's `summary` field and the
 * capability's PII-safe `redactProvenance` preview, so the two can't drift. Carries
 * no values/rationales.
 */
export function summarizeRefinements(
  decisions: RefinementDecision[],
  droppedCount: number
): RefinementSummary {
  return {
    refineCount: decisions.filter((d) => d.action === 'refine').length,
    overwriteCount: decisions.filter((d) => d.action === 'overwrite').length,
    droppedCount,
  };
}
