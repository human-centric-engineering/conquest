/**
 * Confidence accrual for re-confirmed answers — the "strengthen on confirmation" rule.
 *
 * The core of ConQuest is removing the hassle of form-filling: the agent fills answers
 * opportunistically (sometimes on a discounted hunch), then circles back to confirm the
 * shaky ones. When a later turn re-states an answer we ALREADY hold *with the same value*,
 * that re-statement is corroboration — the score should climb toward certainty, and a
 * confirmation must NEVER drag it down. Once it crosses the floor it counts as confirmed
 * and the agent can stop asking.
 *
 * This module is the deterministic write-side guard. It pairs with the extractor prompt
 * (which is *told* to nudge a corroborated position upward): the LLM proposes a score, and
 * {@link accrueConfidence} guarantees the monotonic climb regardless of what the model
 * returns on any single turn. Pure + clock-free, like the rest of the refinement core.
 */

import type { AnswerProvenance } from '@/lib/app/questionnaire/types';

/**
 * The asymptotic ceiling a string of corroborations approaches. The extractor may still
 * emit a higher score for an unusually emphatic direct statement (e.g. 0.98) — accrual
 * never lowers that — but repeat confirmation alone converges here rather than jumping
 * straight to certainty.
 */
export const CONFIDENCE_CEILING = 0.95;

/**
 * Fraction of the remaining gap to the ceiling that each corroboration closes. ~0.34 means
 * a tentative 0.45 climbs 0.45 → 0.62 → 0.73 → 0.80 → … over successive confirmations, so a
 * field needs a few confirmations (not one) to read as Confident — which is the point.
 */
export const CORROBORATION_STEP = 0.34;

/** Round to 3 dp so persisted scores stay tidy (0.617 not 0.6172999…). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Coerce a stored/incoming confidence to a finite number, or null when absent/NaN. */
function asScore(value: number | null | undefined): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

/**
 * Merge a prior confidence with this turn's incoming confidence for a SAME-VALUE
 * re-confirmation. Monotonic by construction — the result is never below either input:
 *
 *  - no prior score yet → take the incoming one (first real capture)
 *  - incoming unscored → keep the prior (a confirmation never erases a score)
 *  - both scored → start from `max(prior, incoming)` (never lower) and step a fraction of
 *    the remaining gap toward {@link CONFIDENCE_CEILING}; a score already at/above the
 *    ceiling is preserved as-is.
 *
 * Only call this when the values genuinely match (use `valuesEqual`); a changed value is an
 * evolution and goes through the refinement path instead.
 */
export function accrueConfidence(
  prior: number | null | undefined,
  incoming: number | null | undefined
): number | null {
  const p = asScore(prior);
  const i = asScore(incoming);
  if (p === null) return i;
  if (i === null) return p;
  const base = Math.max(p, i);
  // base + step·(ceiling − base) overshoots downward once base > ceiling; max() keeps it monotonic.
  const stepped = base + CORROBORATION_STEP * (CONFIDENCE_CEILING - base);
  return round3(Math.max(base, stepped));
}

/**
 * Provenance for a corroborated answer: upgrade to `direct` when the respondent now states
 * it outright, otherwise keep the existing label. A re-confirmation never downgrades a
 * stronger provenance (a `direct` answer stays `direct` even if this turn only inferred it).
 */
export function corroboratedProvenance(
  existing: AnswerProvenance,
  incoming: AnswerProvenance
): AnswerProvenance {
  return incoming === 'direct' ? 'direct' : existing;
}
