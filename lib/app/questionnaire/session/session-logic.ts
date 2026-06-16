/**
 * Pure session state-machine logic (F4.6).
 *
 * Data-in / data-out, no Prisma / Next / LLM: the legal-transition table, the
 * classifier the seam switches on, and the event-type mapping. The seam
 * (`_lib/sessions.ts`) reads the current status, calls {@link classifyTransition},
 * and on `apply` writes the status + the {@link eventTypeFor} event in one
 * transaction; on `noop` it does nothing; on `illegal` it throws.
 *
 * The matrix:
 *
 *  - `active → {paused, completed, abandoned, aborted}`
 *  - `paused → {active (resume), abandoned, aborted}` — NOT `completed`: completion runs the
 *    F4.5 gate/sweep over a *live* session, so a paused session must resume first.
 *  - `completed` / `abandoned` / `aborted` are terminal — no outgoing edges. (`aborted` is the
 *    seriousness-gate terminal; `abandoned` is admin/manual.)
 *  - `from === to` (incl. terminal re-entry) is an idempotent no-op (no event).
 */

import type { SessionStatus } from '@/lib/app/questionnaire/types';
import {
  SessionTransitionError,
  type SessionEventType,
  type TransitionClassification,
} from '@/lib/app/questionnaire/session/types';

/**
 * The legal status changes, keyed by current status. A `from === to` self-edge is
 * deliberately absent here — it's handled as a `noop` by {@link classifyTransition},
 * not as an `apply`, so re-completing a completed session writes no duplicate event.
 */
const LEGAL_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  active: ['paused', 'completed', 'abandoned', 'aborted'],
  paused: ['active', 'abandoned', 'aborted'],
  completed: [],
  abandoned: [],
  aborted: [],
};

/** The terminal statuses — no outgoing transition is legal from these. */
export function isTerminal(status: SessionStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}

/**
 * Grade a requested `from → to` move. The single switch the seam consumes — see
 * {@link TransitionClassification} for the three outcomes.
 */
export function classifyTransition(
  from: SessionStatus,
  to: SessionStatus
): TransitionClassification {
  if (from === to) return 'noop';
  return LEGAL_TRANSITIONS[from].includes(to) ? 'apply' : 'illegal';
}

/** Whether `from → to` is a legal, status-changing transition (`apply`). */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return classifyTransition(from, to) === 'apply';
}

/**
 * Throw {@link SessionTransitionError} if `from → to` is `illegal`. A `noop` is fine
 * (the seam treats it as idempotent) — only genuinely disallowed moves throw.
 */
export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (classifyTransition(from, to) === 'illegal') {
    throw new SessionTransitionError(from, to);
  }
}

/**
 * The event type to record for an `apply` transition. The target status names the
 * event for every edge except resume (`paused → active`), which is `resumed` rather
 * than the initial `active`. Call only for `apply` transitions; a `noop`/`illegal`
 * move has no event.
 */
export function eventTypeFor(from: SessionStatus, to: SessionStatus): SessionEventType {
  if (from === 'paused' && to === 'active') return 'resumed';
  // Exhaustive over the remaining targets — no cast, so a future status that isn't a
  // valid event type can't silently slip through. `active` has no non-resume apply
  // edge (only `paused → active`, handled above), so reaching it is a contract breach.
  switch (to) {
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'abandoned':
      return 'abandoned';
    case 'aborted':
      return 'aborted';
    case 'active':
      throw new SessionTransitionError(from, to);
  }
}
