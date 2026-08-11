/**
 * Completeness milestones — the "you're N% of the way through" nudge (F-progress).
 *
 * Pure and DB-free, and deliberately shared by BOTH turn pipelines (`runTurn` and
 * `runDataSlotTurn`): the two orchestrators compute their own `assessment` but must agree on when
 * a milestone fires, or the feature would silently do nothing on whichever path forgot it.
 *
 * Two rules the shape of this function encodes:
 *
 *  - **Announce at most one banner per turn** — the HIGHEST threshold crossed. A single turn can
 *    jump several thresholds at once (a rich free-text answer filling three slots, or simply a
 *    short questionnaire where one answer is worth 50%), and stacking "You're 25%…", "You're 50%…",
 *    "You're 75%…" beneath one reply reads as a glitch, not encouragement.
 *  - **Bank every threshold crossed, not just the announced one** — the skipped-over ones go into
 *    the ledger so they can never fire later, which would announce progress the respondent has
 *    long since passed.
 *
 * The ledger (`AppQuestionnaireSession.raisedMilestones`) is checked rather than diffing against a
 * previous coverage figure: coverage is NOT monotonic (a contradiction resolution can invalidate an
 * answer and pull it back down), and a ledger means a threshold fires once per session no matter
 * how the number moves afterwards.
 */

import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/** The milestone decision for one turn. */
export interface MilestoneOutcome {
  /**
   * The single threshold to announce this turn (the highest newly crossed), or `null` when nothing
   * was crossed / the feature is off.
   */
  announce: number | null;
  /**
   * The FULL updated ledger to persist to `AppQuestionnaireSession.raisedMilestones`, or
   * `undefined` when nothing changed this turn (leave the column untouched).
   */
  raisedMilestones: number[] | undefined;
}

/** The respondent-facing copy for a crossed threshold. */
export function milestoneMessage(threshold: number): string {
  return `You're ${threshold}% of the way through.`;
}

/**
 * Decide whether this turn crosses a fresh completeness milestone.
 *
 * @param config           the version's milestone settings
 * @param displayCoverage  the graded coverage in [0, 1] — the same figure the progress bar shows
 * @param raised           the session's ledger of already-announced thresholds
 * @param questionCount    how many questions the version has (see the zero-question guard below)
 */
export function resolveMilestoneCrossing(
  config: Pick<QuestionnaireConfigShape, 'milestoneBannerEnabled' | 'milestoneBannerThresholds'>,
  displayCoverage: number,
  raised: number[] | undefined,
  questionCount: number
): MilestoneOutcome {
  if (!config.milestoneBannerEnabled) return { announce: null, raisedMilestones: undefined };

  // A version with no questions has no meaningful progress to report — and both coverage helpers
  // return 1 for an empty question set (`gradedCoverage` short-circuits; the data-slot path pins
  // its ratio to 1), which would otherwise announce the TOP milestone on the opening turn of a
  // pure data-slot version. Guarded here rather than at each call site so neither pipeline can
  // forget it.
  if (questionCount <= 0) return { announce: null, raisedMilestones: undefined };

  // Clamp before rounding so an out-of-range coverage can't reach a threshold it shouldn't.
  const pct = Math.round(Math.min(1, Math.max(0, displayCoverage)) * 100);
  const ledger = raised ?? [];
  const crossed = config.milestoneBannerThresholds.filter((t) => pct >= t && !ledger.includes(t));
  if (crossed.length === 0) return { announce: null, raisedMilestones: undefined };

  const top = Math.max(...crossed);
  const highestAnnounced = ledger.length > 0 ? Math.max(...ledger) : 0;

  return {
    // The highest newly crossed threshold — but only if it's actually ahead of what we've already
    // told them. An admin can add a threshold to a LAUNCHED version (config is editable, and the
    // fork copies it), so a respondent sitting at 92% with 90 already banked can suddenly "cross"
    // a newly-added 60. Announcing that would read "You're 60% of the way through." beside a
    // progress bar showing 92%. Bank it silently instead.
    announce: top > highestAnnounced ? top : null,
    // Every crossed threshold is banked either way, so a skipped-over one never fires later.
    raisedMilestones: [...new Set([...ledger, ...crossed])].sort((a, b) => a - b),
  };
}
