/**
 * Run-level cost cap — pure, DB-free.
 *
 * `AppQuestionnaireConfig.costBudgetUsd` is **per session**. Under `linked` / `stitched`
 * continuity a run holds one session per leg, so a two-leg journey would silently get twice the
 * intended budget and an n-leg one n times. `AppExperience.costBudgetUsd` is the run-level ceiling
 * that closes that gap.
 *
 * Grading delegates to {@link classifyCostCap} rather than re-deriving the ratio: the soft/hard
 * thresholds must mean the same thing at both levels, and one tested implementation is how that
 * stays true.
 */

import { classifyCostCap, type CostCapTier } from '@/lib/app/questionnaire/session/cost-cap';

/** Grade a run's cumulative spend against its run-level budget. `null` budget is uncapped. */
export function classifyRunCostCap(spentUsd: number, capUsd: number | null): CostCapTier {
  return classifyCostCap(spentUsd, capUsd);
}

/**
 * The budget still available to the NEXT leg, or null when the run is uncapped.
 *
 * Never negative: an overspent run reports 0 rather than a negative number.
 *
 * **0 means exhausted, and callers MUST check for it before grading.** Do not pass this value
 * straight into {@link classifyCostCap} expecting a hard stop — that function treats any
 * non-positive cap as *no cap at all* (`capUsd <= 0` → `'none'`), so a 0 handed to it grades as
 * uncapped, the exact opposite of exhausted. The two conventions collide by design: `classifyCostCap`
 * reads 0 as "no budget was configured", while here 0 means "the configured budget is used up".
 *
 * The run-level hard stop is {@link mustConcludeForBudget}, which grades cumulative spend against
 * the *real* cap and is what the handoff gate actually calls.
 */
export function remainingRunBudget(spentUsd: number, capUsd: number | null): number | null {
  if (capUsd === null || capUsd <= 0) return null;
  return Math.max(0, capUsd - spentUsd);
}

/**
 * The cap a leg's turns should actually be graded against — the tighter of the questionnaire's
 * own per-session budget and what the run has left.
 *
 * Either may be null (uncapped); null on both sides means genuinely uncapped. When the run has
 * budget remaining but the session is uncapped, the run's remainder governs, and vice versa.
 *
 * Inherits {@link remainingRunBudget}'s convention: a 0 return means the run is EXHAUSTED, not
 * uncapped. Check for it explicitly before grading — see that function's note.
 */
export function effectiveLegBudget(
  sessionCapUsd: number | null,
  runSpentUsd: number,
  runCapUsd: number | null
): number | null {
  const remaining = remainingRunBudget(runSpentUsd, runCapUsd);
  if (remaining === null) return sessionCapUsd;
  if (sessionCapUsd === null || sessionCapUsd <= 0) return remaining;
  return Math.min(sessionCapUsd, remaining);
}

/**
 * Whether the handoff gate must force a conclude.
 *
 * The single highest-value budget control in the feature: a run at hard cap concludes regardless
 * of what the selector wanted, so an expensive journey cannot start yet another questionnaire.
 */
export function mustConcludeForBudget(spentUsd: number, capUsd: number | null): boolean {
  return classifyRunCostCap(spentUsd, capUsd) === 'hard';
}

export type { CostCapTier };
