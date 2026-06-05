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
 * A `const` tuple for the same single-source reason as the sets in
 * `lib/app/questionnaire/types.ts`: the seam, any Zod enum, and tests derive from it.
 */
export const SESSION_EVENT_TYPES = [
  'created',
  'paused',
  'resumed',
  'completed',
  'abandoned',
  'cost_cap_reached',
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * How {@link classifyTransition} grades a requested `(from → to)` move:
 *
 *  - `apply` — a legal status change: update the status AND write its event.
 *  - `noop` — `from === to` (a self-edge, incl. terminal re-entry like
 *    `completed → completed`): no status change, **no event written**, idempotent.
 *  - `illegal` — a disallowed move (e.g. `completed → active`, `paused → completed`):
 *    the seam throws {@link SessionTransitionError}; the route maps it to 409.
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
