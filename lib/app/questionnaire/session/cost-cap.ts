/**
 * Per-session cost-cap classification (F6.3) — pure, DB-free.
 *
 * A live session carries a per-session USD budget (`AppQuestionnaireConfig.costBudgetUsd`;
 * `null` = uncapped). At each turn boundary the route sums the session's spend so far and
 * grades it against that budget here; the grade drives behaviour:
 *
 *  - `none` — uncapped, or below the soft threshold: run the turn normally.
 *  - `soft` — at/above {@link SOFT_CAP_RATIO} of the budget but still under it: run the
 *    turn, but bias the orchestrator toward offering completion early and add a brief
 *    wrap-up instruction to the offer prose (a nudge, not a refusal).
 *  - `hard` — at/above the budget: refuse the turn (HTTP 402), auto-pause the session, and
 *    write a `cost_cap_reached` event.
 *
 * Pure by design like the rest of the session core (F4.6): data-in/data-out over the spend
 * and the budget, exhaustively unit-testable by hand. The spend figure and the side effects
 * (pause, event, 402) live at the route seam.
 */

/** Fraction of the budget at which the soft cap engages (90%). */
export const SOFT_CAP_RATIO = 0.9;

/** How {@link classifyCostCap} grades the session's spend against its budget. */
export type CostCapTier = 'none' | 'soft' | 'hard';

/**
 * Grade `spentUsd` against the session's `capUsd` budget.
 *
 * A `null`/non-positive budget is uncapped → always `'none'` (a zero or negative cap is
 * treated as "no cap", never an instant hard-stop). `spent ≥ cap` is `'hard'`; otherwise
 * `spent ≥ SOFT_CAP_RATIO · cap` is `'soft'`; else `'none'`.
 */
export function classifyCostCap(spentUsd: number, capUsd: number | null): CostCapTier {
  if (capUsd === null || capUsd <= 0) return 'none';
  if (spentUsd >= capUsd) return 'hard';
  if (spentUsd >= SOFT_CAP_RATIO * capUsd) return 'soft';
  return 'none';
}
