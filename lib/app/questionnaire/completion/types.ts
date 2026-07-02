/**
 * Completion-logic contract and in-memory shapes (F4.5).
 *
 * The conversational engine asks one question at a time (F4.1) and captures typed
 * answers (F4.2). At some point the questionnaire is "done enough" to submit. This
 * module owns the pure decision of **when to offer submission** and **how to resolve
 * the respondent's accept / hold** — entirely in-memory, no Prisma.
 *
 * Two layers, kept separate on purpose:
 *
 *  1. **Eligibility is deterministic.** {@link assessCompletion} reads a
 *     {@link CompletionContext} and returns a {@link CompletionAssessment} — offer,
 *     not-ready, or blocked-on-required — from the version's config thresholds plus a
 *     required-questions gate. It reuses the F4.1 coverage helpers; no LLM, no I/O.
 *  2. **Phrasing is the LLM's job.** When the assessment is `offer`, the engine calls
 *     the F4.5 capability to compose the natural-language offer (the "agent contract",
 *     a {@link CompletionOffer}). The LLM never decides *whether* to offer — only how
 *     to say it — so the deterministic gate (incl. required questions) stays
 *     authoritative.
 *
 * **Pure by design**, like F4.1–F4.4: the session/answer tables exist (F4.4) but the
 * live turn loop doesn't (F4.6), so the core reads a caller-assembled context (a
 * Vitest harness or the preview route today, the engine later). Persisting the
 * `active → completed` transition is the route's job, at the DB seam.
 */

import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/**
 * Everything {@link assessCompletion} reads — the version's questions, the answers
 * captured so far, and the resolved config. Structurally a `SelectionContext`
 * minus the selection-only fields (`round`, `recentMessages`), so the F4.1 coverage
 * helpers accept it directly and the preview route can pass the same context
 * `buildSelectionContext` already produces.
 */
export interface CompletionContext {
  /** Every question slot in the version (carries `required`, `weight`, ordinals). */
  questions: QuestionView[];
  /** Answers captured so far this session. */
  answered: AnsweredView[];
  /** The version's resolved config (defaults when no row was ever saved). */
  config: QuestionnaireConfigShape;
  /** Stable session identity — threaded into cost-log metadata downstream. */
  sessionId: string;
}

/**
 * The shape of a completion assessment.
 *
 * - `offer` — the agent may offer to submit (thresholds met, or the per-session cap
 *   is hit). `unmet` is empty.
 * - `not_ready` — completion thresholds aren't met yet; `unmet` lists which.
 * - `blocked_on_required` — one or more required questions are unanswered. This
 *   blocks the offer even when weighted coverage already meets the threshold (a
 *   low-weight required slot must still be answered).
 */
export const COMPLETION_KINDS = ['offer', 'not_ready', 'blocked_on_required'] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

/**
 * The specific criteria a non-`offer` assessment failed. Empty when `kind` is
 * `offer`. `required_unanswered` accompanies `blocked_on_required`; the other two
 * accompany `not_ready`.
 */
export const UNMET_CRITERIA = [
  'coverage_below_threshold',
  'below_min_answered',
  'required_unanswered',
] as const;
export type UnmetCriterion = (typeof UNMET_CRITERIA)[number];

/** The deterministic completion assessment for one turn. */
export interface CompletionAssessment {
  /** Whether the agent may offer to submit, and if not, why not. */
  kind: CompletionKind;
  /** Human-readable account of the decision. */
  rationale: string;
  /** Which criteria are unmet — empty iff `kind === 'offer'`. */
  unmet: UnmetCriterion[];
  /** Weighted coverage in [0, 1] at assessment time — the GATE figure (below-floor answers excluded). */
  coverage: number;
  /**
   * Graded coverage in [0, 1] for the progress DISPLAY only — never a gate input. Full credit for
   * confirmed answers (confidence ≥ the completion floor, or unscored/authoritative),
   * `TENTATIVE_ANSWER_CREDIT` (0.5) for below-floor tentative captures. Equals {@link coverage} when
   * the floor is 0. The progress bar reads this so a session holding only tentative captures shows
   * real momentum instead of a flat 0%.
   */
  displayCoverage: number;
  /** Distinct questions answered this session. */
  answeredCount: number;
  /** The keys of unanswered required questions — the gate's evidence. */
  requiredUnansweredKeys: string[];
  /** Whether the per-session cap (`maxQuestionsPerSession`) forced the offer. */
  capReached: boolean;
  /**
   * Whether the respondent may *voluntarily* finish now (the F-early-finish escape hatch),
   * independent of `kind`. Computed from the early-finish config (`allowEarlyFinish` +
   * the OR of `earlyFinishMinCoverage` / `earlyFinishMinQuestions`); deliberately does NOT
   * consult the required-question gate — early finish bypasses it. `false` when the feature
   * is off or no bar is met yet. Distinct from `kind === 'offer'`, which is the agent's own
   * threshold-met offer; both can be true at once.
   */
  earlyFinishAvailable: boolean;
}

/**
 * What the respondent does with an offer: `accept` (submit), `hold` (keep going), or
 * `finish_early` (voluntarily end via the escape hatch, bypassing the required gate).
 * The engine/route maps the respondent's action onto one of these before resolving.
 */
export const COMPLETION_ACTIONS = ['accept', 'hold', 'finish_early'] as const;
export type CompletionAction = (typeof COMPLETION_ACTIONS)[number];

/**
 * The outcome of resolving a respondent action against an assessment + the
 * completion-sweep result.
 *
 * - `submit` — accepted and clean (sweep didn't run, or found nothing): the session
 *   should transition to `completed`.
 * - `hold_for_review` — accepted but the completion-sweep found contradictions: do
 *   NOT submit. Surface the conflicts for reconciliation (F4.4), then re-offer. The
 *   session stays `active`.
 * - `continue` — the respondent held (or accept was attempted while ineligible):
 *   keep asking. The session stays `active`.
 */
export type CompletionResolution =
  | { kind: 'submit'; rationale: string }
  | { kind: 'hold_for_review'; rationale: string; contradictionCount: number }
  | { kind: 'continue'; rationale: string };

/**
 * The completion-sweep outcome fed into {@link resolveCompletion}. The *decision* to
 * run is pure (`shouldRunDetection`, F4.3); the *execution* (LLM dispatch) is impure
 * and happens in the route, which passes the resulting count back in so the resolver
 * stays pure.
 */
export interface CompletionSweepResult {
  /** Whether the completion-sweep ran (false when mode is `off` or detection is disabled). */
  run: boolean;
  /** How many contradictions the sweep surfaced (0 when it didn't run). */
  contradictionCount: number;
}

/**
 * The "agent contract": the natural-language offer the F4.5 capability composes when
 * an assessment is `offer`. The LLM produces this; the deterministic core never does.
 */
export interface CompletionOffer {
  /** The message the agent says to offer submission. */
  offerMessage: string;
  /** A short recap of what's been covered, to frame the offer. */
  coveredSummary: string;
  /** An optional note on what remains optional/skippable, if anything. */
  remainingNote?: string;
}
