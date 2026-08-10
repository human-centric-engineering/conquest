/**
 * Session state-machine contract and in-memory shapes (F4.6).
 *
 * A respondent's run over a version moves through a small lifecycle —
 * `active | paused | completed | abandoned` ({@link SessionStatus}, types.ts) — and
 * every transition is recorded as one append-only `AppQuestionnaireSessionEvent` row
 * (the audit trail). This module owns the **pure** decision of which transitions are
 * legal and what event each writes; the DB writes live at the route-local seam
 * (`app/api/v1/app/questionnaires/_lib/sessions.ts`).
 *
 * **Pure by design**, like F4.1–F4.5: the transition rules are a data-in/data-out
 * function over the current + requested status, so the whole machine is exhaustively
 * unit-testable by hand (the DoP for P4). The turn loop that will drive these
 * transitions live is F6.1; F4.6 ships the machine and exercises it by hand.
 */

import type { SessionStatus } from '@/lib/app/questionnaire/types';

/**
 * The event types written to `AppQuestionnaireSessionEvent`. Four mirror the status
 * transitions; `resumed` names the `paused → active` edge (distinct from the initial
 * `active`); `cost_cap_reached` is a **non-transition** event (no status change) — the
 * hook F6.3/F6.5 fires when a session hits its budget, wired here but never fired in
 * F4.6.
 *
 * `reopened` is the one deliberate exception to the terminal-`completed` rule: the
 * respondent early-finish "back to conversation" feature. Unlike every other entry
 * here, it is never produced by {@link eventTypeFor}/`classifyTransition` — those still
 * treat `completed → active` as unconditionally `illegal` (see
 * {@link TransitionClassification} below). `reopened` is written directly by
 * `reopenSession` (`app/api/v1/app/questionnaires/_lib/sessions.ts`), a narrow,
 * purpose-built seam that bypasses the shared transition matrix entirely so no other
 * caller (`resumeSession`, the admin `/transition` route) can traverse
 * `completed → active`.
 *
 * A `const` tuple for the same single-source reason as the sets in
 * `lib/app/questionnaire/types.ts`: the seam, any Zod enum, and tests derive from it.
 */
export const SESSION_EVENT_TYPES = [
  'created',
  'paused',
  'resumed',
  'completed',
  'abandoned',
  // Seriousness/abuse gate terminal — mirrors the `aborted` status transition.
  'aborted',
  'cost_cap_reached',
  // Sensitivity awareness / safeguarding: a non-transition event recorded when a sensitive
  // disclosure is flagged (metadata: { severity, category } — never the summary).
  'sensitivity_flagged',
  // Respondent early-finish "back to conversation" — see the doc comment above.
  'reopened',
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * How {@link classifyTransition} grades a requested `(from → to)` move:
 *
 *  - `apply` — a legal status change: update the status AND write its event.
 *  - `noop` — `from === to` (a self-edge, incl. terminal re-entry like
 *    `completed → completed`): no status change, **no event written**, idempotent.
 *  - `illegal` — a disallowed move (e.g. `abandoned → active`, `paused → completed`):
 *    the seam throws {@link SessionTransitionError}; the route maps it to 409.
 *
 * `completed → active` is illegal for this classifier **unconditionally and always** —
 * that never changes, and `LEGAL_TRANSITIONS.completed` in `session-logic.ts` stays
 * `[]`. The respondent "reopen" feature does not use this classifier or the shared
 * matrix at all; it is a separately-gated, separately-implemented seam (`reopenSession`)
 * that only a narrow eligibility check (early-finish origin, config still on, not an
 * experience leg) may invoke. Do not "helpfully" add `active` to
 * `LEGAL_TRANSITIONS.completed` — that would let every caller of the shared matrix
 * (including admin resume) reopen *any* completed session unconditionally.
 */
export type TransitionClassification = 'apply' | 'noop' | 'illegal';

/**
 * Thrown by {@link assertTransition} (and the seam) when a transition is `illegal`.
 * Framework-free — the pure core has no Next.js/HTTP dependency; the transition route
 * catches it and maps to a 409 Conflict.
 */
export class SessionTransitionError extends Error {
  readonly from: SessionStatus;
  readonly to: SessionStatus;

  constructor(from: SessionStatus, to: SessionStatus) {
    super(`Illegal session transition: ${from} → ${to}`);
    this.name = 'SessionTransitionError';
    this.from = from;
    this.to = to;
  }
}
