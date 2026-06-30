/**
 * Pure completion assessment + resolution (F4.5).
 *
 * Two data-in / data-out exports, no Prisma / Next / LLM:
 *
 *  1. {@link assessCompletion} — the deterministic "may we offer to submit?" gate.
 *     Reuses the F4.1 coverage helpers (`coverageRatio`, `answeredCount`,
 *     `unansweredQuestions`) so the completion and selection layers can't drift on
 *     what "covered" means, and adds the one piece selection lacks: a
 *     required-questions gate. Ordering mirrors `terminalDecision`'s (cap first, then
 *     thresholds) so a capped session can always submit.
 *
 *  2. {@link resolveCompletion} — maps the respondent's accept/hold plus the
 *     completion-sweep result onto a {@link CompletionResolution}. Accepting with a
 *     clean (or skipped) sweep submits; accepting with sweep contradictions holds for
 *     review (never auto-submit over a conflict); holding continues.
 *
 * The sweep's *execution* is impure and lives in the route; this module only consumes
 * its already-computed count, so it stays exhaustively unit-testable by hand.
 */

import {
  answeredCount,
  coverageRatio,
  unansweredQuestions,
} from '@/lib/app/questionnaire/selection/context';
import type {
  CompletionAction,
  CompletionAssessment,
  CompletionContext,
  CompletionResolution,
  CompletionSweepResult,
  UnmetCriterion,
} from '@/lib/app/questionnaire/completion/types';

/**
 * Float tolerance for the coverage-vs-threshold comparison — the same epsilon
 * `terminalDecision` uses. Summing fractional weights in two orders can leave a
 * fully-answered session at 0.9999999998 of itself, which would miss a
 * `coverageThreshold` of 1 and wrongly report a finished questionnaire as not-ready.
 */
const COVERAGE_EPSILON = 1e-9;

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * The respondent-controlled early-finish escape hatch (F-early-finish). Orthogonal to the
 * agent's own `offer` gate and — deliberately — to the required-question gate: a respondent
 * who opts to finish early may do so with required questions still open.
 *
 * Unlock rule: `allowEarlyFinish` AND
 *   - both minimums `0` ⇒ available from the start, else
 *   - coverage ≥ `earlyFinishMinCoverage` (when that bar is set), OR
 *   - answered ≥ `earlyFinishMinQuestions` (when that bar is set).
 *
 * A bar of `0` means "not a criterion on that axis" — it never contributes to the OR (so a
 * single configured bar gates alone rather than being trivially satisfied by the zeroed one).
 */
export function isEarlyFinishAvailable(
  config: CompletionContext['config'],
  coverage: number,
  answered: number
): boolean {
  if (!config.allowEarlyFinish) return false;
  const minCoverage = config.earlyFinishMinCoverage;
  const minQuestions = config.earlyFinishMinQuestions;
  if (minCoverage <= 0 && minQuestions <= 0) return true;
  const coverageMet = minCoverage > 0 && coverage + COVERAGE_EPSILON >= minCoverage;
  const questionsMet = minQuestions > 0 && answered >= minQuestions;
  return coverageMet || questionsMet;
}

/**
 * Assess whether the agent may offer to submit. Ordering matters:
 *
 *  1. **Cap** — `maxQuestionsPerSession` reached → `offer` (a capped session can
 *     always submit, even with coverage unmet), flagged `capReached`.
 *  2. **Required gate** — any unanswered *required* slot → `blocked_on_required`.
 *     Checked before the coverage thresholds because weighted coverage can clear the
 *     bar while a low-weight required slot is still open; a required question is
 *     mandatory by definition.
 *  3. **Thresholds** — coverage ≥ `coverageThreshold` AND answered ≥
 *     `minQuestionsAnswered` → `offer`.
 *  4. Otherwise → `not_ready`, listing the specific unmet criteria.
 */
export function assessCompletion(ctx: CompletionContext): CompletionAssessment {
  const { maxQuestionsPerSession: cap, coverageThreshold, minQuestionsAnswered } = ctx.config;

  // Confirmation floor (opportunistic fill): a tentative answer scored BELOW the floor is a guess
  // the agent hasn't yet had corroborated — it must not count toward coverage / the min, nor unblock
  // a required question, until a confirmation raises it. Unscored answers (`null`) are authoritative
  // (respondent edits / non-opportunistic captures), so they always count. With the floor at 0 this
  // is a no-op, preserving the prior "filled is enough" behaviour.
  const floor = ctx.config.answerConfidenceFloor;
  const gated: CompletionContext =
    floor > 0
      ? { ...ctx, answered: ctx.answered.filter((a) => (a.confidence ?? 1) >= floor) }
      : ctx;

  const answered = answeredCount(gated);
  const coverage = coverageRatio(gated);

  const requiredUnansweredKeys = unansweredQuestions(gated)
    .filter((q) => q.required)
    .map((q) => q.key);

  const base = {
    coverage,
    answeredCount: answered,
    requiredUnansweredKeys,
    earlyFinishAvailable: isEarlyFinishAvailable(ctx.config, coverage, answered),
  };

  // 1. Hard cap → offer regardless of coverage. The cap is an explicit "stop here".
  if (cap !== null && answered >= cap) {
    return {
      kind: 'offer',
      unmet: [],
      capReached: true,
      rationale: `Reached the per-session cap of ${cap} question${cap === 1 ? '' : 's'}; ready to submit.`,
      ...base,
    };
  }

  // 2. Required gate → a required question left open blocks the offer outright.
  if (requiredUnansweredKeys.length > 0) {
    const n = requiredUnansweredKeys.length;
    return {
      kind: 'blocked_on_required',
      unmet: ['required_unanswered'],
      capReached: false,
      rationale: `${n} required question${n === 1 ? '' : 's'} still unanswered (${requiredUnansweredKeys.join(', ')}); cannot offer to submit yet.`,
      ...base,
    };
  }

  // 3. Completion thresholds: both coverage AND min-answered must be met.
  const coverageMet = coverage + COVERAGE_EPSILON >= coverageThreshold;
  const minMet = answered >= minQuestionsAnswered;
  if (coverageMet && minMet) {
    return {
      kind: 'offer',
      unmet: [],
      capReached: false,
      rationale: `Coverage ${pct(coverage)} meets the ${pct(coverageThreshold)} threshold with ${answered} answered (min ${minQuestionsAnswered}); ready to submit.`,
      ...base,
    };
  }

  // 4. Not ready — name what's unmet.
  const unmet: UnmetCriterion[] = [];
  if (!coverageMet) unmet.push('coverage_below_threshold');
  if (!minMet) unmet.push('below_min_answered');
  return {
    kind: 'not_ready',
    unmet,
    capReached: false,
    rationale: `Not ready to submit: coverage ${pct(coverage)} (need ${pct(coverageThreshold)}), ${answered} answered (need ${minQuestionsAnswered}).`,
    ...base,
  };
}

/**
 * Resolve a respondent action against the assessment + the completion-sweep result.
 *
 *  - `hold` → `continue` (keep asking), whatever the assessment.
 *  - `finish_early` while `earlyFinishAvailable` → `submit` (the escape hatch): no sweep —
 *    a deliberate bail-out, and contradictions already surface live during the chat. Bypasses
 *    the required/threshold gate by design. Not available → `continue` (defends a forged client).
 *  - `accept` while the assessment isn't `offer` → `continue`: accept can't bypass the
 *    required/threshold gate (the route should not normally reach here, but the core
 *    defends against it rather than submitting an ineligible session).
 *  - `accept` + sweep didn't run (mode off / detection disabled) → `submit`.
 *  - `accept` + sweep ran with 0 contradictions → `submit`.
 *  - `accept` + sweep ran with ≥1 contradiction → `hold_for_review`: never auto-submit
 *    over a conflict; surface it for reconciliation, then re-offer.
 */
export function resolveCompletion(
  action: CompletionAction,
  assessment: CompletionAssessment,
  sweep: CompletionSweepResult
): CompletionResolution {
  if (action === 'hold') {
    return { kind: 'continue', rationale: 'Respondent chose to keep going.' };
  }

  // Respondent-controlled early finish: submit immediately when unlocked, bypassing the
  // required/threshold gate and the sweep. Defends against an ineligible (stale/forged) request.
  if (action === 'finish_early') {
    return assessment.earlyFinishAvailable
      ? { kind: 'submit', rationale: 'Respondent chose to finish early.' }
      : { kind: 'continue', rationale: 'Early finish is not available for this session.' };
  }

  // accept, but the deterministic gate says we shouldn't have offered.
  if (assessment.kind !== 'offer') {
    return {
      kind: 'continue',
      rationale: `Cannot submit: ${assessment.rationale}`,
    };
  }

  if (sweep.run && sweep.contradictionCount > 0) {
    const n = sweep.contradictionCount;
    return {
      kind: 'hold_for_review',
      contradictionCount: n,
      rationale: `Completion sweep found ${n} contradiction${n === 1 ? '' : 's'} to reconcile before submitting.`,
    };
  }

  return {
    kind: 'submit',
    rationale: sweep.run
      ? 'Accepted; completion sweep found no contradictions.'
      : 'Accepted; no completion sweep required.',
  };
}
