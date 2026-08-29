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

import { progressPctFromCoverage } from '@/lib/app/questionnaire/completion/progress';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/** The milestone decision for one turn. */
export interface MilestoneOutcome {
  /**
   * The single threshold to announce this turn (the highest newly crossed), or `null` when nothing
   * was crossed / the feature is off. This is the DECISION value — the ledger's unit, and what
   * "once per threshold per session" is keyed on. It is deliberately NOT what the banner states;
   * see {@link coveragePct}.
   */
  announce: number | null;
  /**
   * The respondent's clamped, rounded coverage — the figure the progress bar shows, and the one the
   * banner states.
   *
   * Separate from {@link announce} because the two genuinely differ: a turn that crosses 25 may
   * land the respondent at 30, and a single rich answer can take them from 0 to 92 while crossing a
   * lone configured threshold of 40. Announcing the THRESHOLD there read "You're 40% of the way
   * through." beside a bar showing 92% — the copy understated progress by however far apart the
   * admin's thresholds happen to sit. The threshold decides *whether* to speak; coverage decides
   * *what is true*. Always present, so callers never have to re-derive the clamp-and-round and
   * drift from it.
   */
  coveragePct: number;
  /**
   * The FULL updated ledger to persist to `AppQuestionnaireSession.raisedMilestones`, or
   * `undefined` when nothing changed this turn (leave the column untouched).
   */
  raisedMilestones: number[] | undefined;
}

/**
 * The respondent-facing copy. Takes the respondent's ACTUAL coverage, not the threshold that fired
 * — see {@link MilestoneOutcome.coveragePct}.
 */
export function milestoneMessage(coveragePct: number): string {
  return `You're ${coveragePct}% of the way through.`;
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
  // Clamp before rounding so an out-of-range coverage can't reach a threshold it shouldn't.
  // Computed up front so every return path carries the same figure the progress bar shows — via the
  // shared helper, so the banner's number and the bar's can never be rounded differently.
  const pct = progressPctFromCoverage(displayCoverage);
  const silent = { announce: null, coveragePct: pct, raisedMilestones: undefined };

  if (!config.milestoneBannerEnabled) return silent;

  // A version with no questions has no meaningful progress to report — and both coverage helpers
  // return 1 for an empty question set (`gradedCoverage` short-circuits; the data-slot path pins
  // its ratio to 1), which would otherwise announce the TOP milestone on the opening turn of a
  // pure data-slot version. Guarded here rather than at each call site so neither pipeline can
  // forget it.
  if (questionCount <= 0) return silent;

  const ledger = raised ?? [];
  const crossed = config.milestoneBannerThresholds.filter((t) => pct >= t && !ledger.includes(t));
  if (crossed.length === 0) return silent;

  const top = Math.max(...crossed);
  const highestAnnounced = ledger.length > 0 ? Math.max(...ledger) : 0;

  return {
    // The highest newly crossed threshold — but only if it's actually ahead of what we've already
    // told them. An admin can add a threshold to a LAUNCHED version (config is editable, and the
    // fork copies it), so a respondent sitting at 92% with 90 already banked can suddenly "cross"
    // a newly-added 60. Re-announcing there would repeat a beat they have already had. Bank it
    // silently instead.
    //
    // The banner's NUMBER is `coveragePct` — the UN-ratcheted figure — and since F17.33 the bar
    // draws the ratcheted `progressPct`, so the two CAN read differently for a session whose scope
    // widened: the bar holds at the highest figure already shown while the banner states the honest
    // one. That is the deliberate half of the trade, not an oversight. A banner is spent once per
    // threshold and must be spent on a figure the respondent genuinely reached, which a presentation
    // floor is not. See `progress.ts` and completion-logic.md.
    announce: top > highestAnnounced ? top : null,
    coveragePct: pct,
    // Every crossed threshold is banked either way, so a skipped-over one never fires later.
    raisedMilestones: [...new Set([...ledger, ...crossed])].sort((a, b) => a - b),
  };
}
