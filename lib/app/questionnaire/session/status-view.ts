/**
 * Respondent session-status view — pure projection (F7.3).
 *
 * The respondent chat surface needs to know, after each turn settles, three things the
 * SSE stream doesn't carry: whether the agent may now offer submission, whether the
 * session is approaching its cost budget, and whether it's running anonymously. This
 * module owns the **pure** mapping from the already-computed completion assessment
 * (F4.5), cost-cap tier (F6.3), and session status (F4.6) into the client-safe
 * {@link SessionStatusView} the `GET …/status` route returns.
 *
 * Pure by design like the rest of the session core: data-in/data-out, no Prisma/Next,
 * exhaustively unit-testable by hand. The DB reads + flag checks live at the route seam
 * (`app/api/v1/app/questionnaire-sessions/_lib/session-status.ts`).
 *
 * Deliberately narrow: authoring internals (weights, tags, thresholds) and the raw USD
 * spend are NOT projected — the respondent sees the completion *kind* + coverage and a
 * coarse cost *tier*, never the underlying numbers (same quiet-signal discipline as the
 * F7.2 answer panel's confidence dot). `requiredUnansweredKeys` are slot keys already
 * known to the panel, not authoring detail.
 */

import type { CostCapTier } from '@/lib/app/questionnaire/session/cost-cap';
import type {
  CompletionAssessment,
  CompletionKind,
} from '@/lib/app/questionnaire/completion/types';
import type { SessionStatus } from '@/lib/app/questionnaire/types';

/** The completion half of the status view — a respondent-safe slice of the F4.5 assessment. */
export interface StatusCompletionView {
  /** Whether the agent may offer to submit, and if not, why not (offer / not_ready / blocked_on_required). */
  kind: CompletionKind;
  /** Weighted coverage in [0, 1]. */
  coverage: number;
  /** Distinct questions answered this session. */
  answeredCount: number;
  /** Keys of unanswered required questions (empty unless `kind === 'blocked_on_required'`). */
  requiredUnansweredKeys: string[];
  /** Whether the per-session question cap forced the offer. */
  capReached: boolean;
  /**
   * Whether the respondent may voluntarily finish now (the early-finish escape hatch), independent
   * of `kind`. Drives the persistent Continue / Finish-up control. `false` when the feature is off
   * or no configured bar is met yet.
   */
  earlyFinishAvailable: boolean;
}

/**
 * The respondent-facing session status. `cost` is `null` for an uncapped session (or one
 * whose cap enforcement is disabled); otherwise it carries only the coarse tier, never the
 * spend. A `hard` tier on a `paused` session tells the UI the pause was budget-driven
 * (terminal, not resumable) vs. a respondent-initiated pause (resumable).
 */
export interface SessionStatusView {
  status: SessionStatus;
  completion: StatusCompletionView;
  cost: { tier: CostCapTier } | null;
  anonymous: boolean;
  /**
   * The session's raw support reference (`publicRef`), or `null` for a row predating the column.
   * The UI groups it for display (`formatSessionRef`); it's the code a respondent quotes when
   * reporting a problem so an admin can look the session up.
   */
  ref: string | null;
}

/** Inputs the pure builder maps — all already computed by the route seam. */
export interface SessionStatusInput {
  status: SessionStatus;
  assessment: CompletionAssessment;
  /** Cost-cap tier; ignored when `capped` is false. */
  costTier: CostCapTier;
  /** Whether a positive budget is configured AND enforcement is enabled. */
  capped: boolean;
  /** True for a no-login session (`respondentUserId === null`). */
  anonymous: boolean;
  /** The session's raw support reference, or null for a row predating the column. */
  ref: string | null;
}

/** Map the assessment + cost tier + status into the client-safe view. */
export function buildSessionStatusView(input: SessionStatusInput): SessionStatusView {
  return {
    status: input.status,
    completion: {
      kind: input.assessment.kind,
      coverage: input.assessment.coverage,
      answeredCount: input.assessment.answeredCount,
      requiredUnansweredKeys: input.assessment.requiredUnansweredKeys,
      capReached: input.assessment.capReached,
      earlyFinishAvailable: input.assessment.earlyFinishAvailable,
    },
    cost: input.capped ? { tier: input.costTier } : null,
    anonymous: input.anonymous,
    ref: input.ref,
  };
}

/**
 * Whether the respondent may submit right now: only an `active` session in an `offer`
 * state. Shared by the UI (to show the Submit affordance) and mirrors the submit route's
 * gate so the button and the endpoint can't disagree.
 */
export function canSubmitSession(view: SessionStatusView): boolean {
  return view.status === 'active' && view.completion.kind === 'offer';
}

/**
 * Whether the respondent may *voluntarily* finish early right now: an `active` session whose
 * assessment unlocked the escape hatch. Orthogonal to {@link canSubmitSession} — both can be
 * true at once (the UI prefers the full submit offer when so). Mirrors the submit route's
 * early-finish gate so the control and the endpoint can't disagree.
 */
export function canFinishEarly(view: SessionStatusView): boolean {
  return view.status === 'active' && view.completion.earlyFinishAvailable;
}
