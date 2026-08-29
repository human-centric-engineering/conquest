/**
 * The displayed progress figure (F17.33) — pure, DB-free, and deliberately separate from every
 * gate.
 *
 * `assessCompletion` produces two numbers that look alike and do different jobs: `coverage` decides
 * whether the respondent may submit, and `displayCoverage` is what the progress bar draws. Only the
 * second one is here, because only the second one is a **promise to a person**.
 *
 * Conditional Topics can widen an interview after it has started — the plan landing at the end of
 * the opening (every conditional-topics session) and a respondent amendment (F17.6) both add
 * questions to the in-scope set, which is the denominator. Recomputed honestly, the percentage
 * therefore falls, at the exact moment the interviewer is announcing what it will cover next.
 *
 * Two rules answer that, and they are separate on purpose:
 *
 *  - **The denominator is chosen so the figure moves the right way** — see `progressQuestions` on
 *    {@link import('@/lib/app/questionnaire/completion/types').CompletionContext}. Before the plan
 *    exists, progress is measured against every question that could still be asked, so the plan
 *    narrowing the interview moves the bar UP.
 *  - **The figure never goes backwards** — this module. A session-scoped floor, banked on the turn
 *    path and applied on the read path.
 *
 * A stalled bar reads as "this part is taking a while"; a reversing bar reads as the system taking
 * something back. That is the whole trade, and it is worth being explicit that the second rule buys
 * it at the cost of momentary precision.
 *
 * **The floor is presentation state, never a measurement.** No analytic, report, cohort figure or
 * export may read it — `displayCoverage` remains the un-ratcheted truth for everything that is not
 * a bar, and the milestone ledger is deliberately fed the un-ratcheted figure too (see
 * {@link resolveDisplayedProgress}).
 */

/**
 * The highest figure the FLOOR may ever display. 100% is a claim that nothing is left, and only the
 * true computed figure is allowed to make it.
 *
 * Reachable in one way: complete a narrower interview, then have it widened (a late amendment).
 * Sitting at "100% completed" while the interviewer asks four more questions is a worse lie than
 * any drop, so the ratchet stalls one point short and the true figure retakes it from below.
 */
export const PROGRESS_RATCHET_CEILING = 99;

/** The displayed progress decision for one turn / one read. */
export interface ProgressOutcome {
  /** The whole-percent figure to draw. */
  pct: number;
  /**
   * The floor to persist to `AppQuestionnaireSession.progressFloorPct`, or `undefined` when it did
   * not move this turn (leave the column untouched) — the same convention
   * `MilestoneOutcome.raisedMilestones` uses, so a caller can write both with one `...spread`.
   *
   * Only the turn path ever acts on this. The read path (`loadSessionStatus`) applies the stored
   * floor and discards this: a GET does not write, and it does not need to — nothing moves the
   * coverage between turns.
   */
  progressFloorPct: number | undefined;
}

/**
 * Coverage in [0, 1] → the whole percent the respondent sees.
 *
 * Clamp before rounding, so an out-of-range coverage can't round its way past a milestone threshold
 * it never reached. Shared with {@link import('./milestones').resolveMilestoneCrossing} so the bar
 * and the banner can never state different numbers for the same coverage.
 */
export function progressPctFromCoverage(coverage: number): number {
  return Math.round(Math.min(1, Math.max(0, coverage)) * 100);
}

/**
 * Apply the session's progress floor to this turn's computed figure.
 *
 * @param computedPct  the honest figure, a whole percent (see {@link progressPctFromCoverage})
 * @param floorPct     the session's stored floor; a junk value degrades to 0 rather than throwing,
 *                     because a bad column must never take down a turn
 */
export function resolveDisplayedProgress(computedPct: number, floorPct: number): ProgressOutcome {
  const computed = clampPct(computedPct);
  const floor = clampPct(floorPct);

  // Genuine completion is the one figure the floor never overrides — in either direction. It cannot
  // be held DOWN by a lower floor (the max sees to that), and it is the only way 100 is ever shown.
  const pct = computed >= 100 ? 100 : Math.min(Math.max(computed, floor), PROGRESS_RATCHET_CEILING);

  return { pct, progressFloorPct: pct > floor ? pct : undefined };
}

/** Defensive clamp + round: the floor arrives from a Json-adjacent column and the coverage from a sum of weights. */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}
