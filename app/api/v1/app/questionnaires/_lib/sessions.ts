/**
 * Route-local session-lifecycle persistence seam (F4.6).
 *
 * The DB write path for the session state machine. The pure core
 * (`lib/app/questionnaire/session/**`) decides which transitions are legal and what
 * event each writes; this seam performs the I/O: read the current status, validate the
 * move, and — atomically — update the status AND append one `AppQuestionnaireSessionEvent`
 * row (the audit trail). Like the answer-slot seam (`answer-slots.ts`), it's route-local
 * for now; F6.1's live turn loop may promote it to a shared lib module.
 *
 * The single writer is {@link transitionSession}; {@link pauseSession} /
 * {@link resumeSession} / {@link abandonSession} / {@link markSessionCompleted} are thin
 * status-specific wrappers. {@link recordCostCapReached} writes a non-transition
 * `cost_cap_reached` event (no status change) — the budget hook F6.3/F6.5 will fire,
 * wired here but never fired in F4.6. {@link loadSessionResumeState} is the "resume"
 * read: a paused session's status plus the answers captured so far, so the caller picks
 * up where it left off (turn-free — the live turn loop is F6.1).
 *
 * `markSessionCompleted` lives here (moved from `answer-slots.ts`, which re-exports it
 * for the F4.5 `/complete` route) so completion now writes its `completed` event like
 * every other transition.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { NotFoundError } from '@/lib/api/errors';
import {
  ANSWER_PROVENANCES,
  SENSITIVITY_FLAGGED_EVENT,
  SESSION_STATUSES,
  narrowToEnum,
  type AnswerProvenance,
  type SensitivitySeverity,
  type SessionStatus,
} from '@/lib/app/questionnaire/types';
import type { SensitivityNote } from '@/lib/app/questionnaire/sensitivity/types';
import { classifyTransition, eventTypeFor } from '@/lib/app/questionnaire/session/session-logic';
import { SessionTransitionError } from '@/lib/app/questionnaire/session/types';

/** Optional detail recorded on a transition's event row. */
export interface TransitionOptions {
  /** Human-readable note (e.g. why a session was abandoned). */
  reason?: string;
  /** Event-specific structured detail, stored on `metadata`. */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Transition a session to `to`, recording the audit event — the single writer the
 * wrappers delegate to. In one transaction: read the current status, classify the
 * `from → to` move via the pure core, then:
 *
 *  - `illegal` → throw {@link SessionTransitionError} (the route maps it to 409); nothing
 *    is written.
 *  - `noop` (`from === to`, incl. terminal re-entry like `completed → completed`) → no
 *    write, no event; returns the current status. This is what keeps the F4.5
 *    accept→submit path idempotent.
 *  - `apply` → update `status` AND insert one event ({@link eventTypeFor}); returns `to`.
 *
 * Status update and event insert share a transaction so a status can never change
 * without its audit row (or vice-versa). Throws {@link NotFoundError} if the session id
 * doesn't resolve.
 */
export async function transitionSession(
  sessionId: string,
  to: SessionStatus,
  opts: TransitionOptions = {}
): Promise<SessionStatus> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { status: true, invitationId: true },
    });
    if (!row) throw new NotFoundError('Session not found');

    const from = narrowToEnum(row.status, SESSION_STATUSES, 'active');
    const classification = classifyTransition(from, to);

    if (classification === 'illegal') {
      throw new SessionTransitionError(from, to);
    }
    if (classification === 'noop') {
      return from;
    }

    await tx.appQuestionnaireSession.update({
      where: { id: sessionId },
      data: { status: to },
    });
    await tx.appQuestionnaireSessionEvent.create({
      data: {
        sessionId,
        eventType: eventTypeFor(from, to),
        fromStatus: from,
        toStatus: to,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      },
    });
    // Invitations: stamp the frictionless invite as completed when its bound session completes
    // (status-only, invariant-safe — see invitations/linkage.ts). `updateMany` with a non-terminal
    // guard keeps it idempotent and never resurrects a revoked invitation.
    if (to === 'completed' && row.invitationId) {
      await tx.appQuestionnaireInvitation.updateMany({
        where: { id: row.invitationId, status: { notIn: ['completed', 'revoked'] } },
        data: { status: 'completed' },
      });
    }
    return to;
  });
}

/** Pause an active session (`active → paused`). Idempotent if already paused. */
export function pauseSession(sessionId: string, opts?: TransitionOptions): Promise<SessionStatus> {
  return transitionSession(sessionId, 'paused', opts);
}

/** Resume a paused session (`paused → active`), writing a `resumed` event. */
export function resumeSession(sessionId: string, opts?: TransitionOptions): Promise<SessionStatus> {
  return transitionSession(sessionId, 'active', opts);
}

/** Abandon a session (`active|paused → abandoned`). Terminal. */
export function abandonSession(
  sessionId: string,
  opts?: TransitionOptions
): Promise<SessionStatus> {
  return transitionSession(sessionId, 'abandoned', opts);
}

/**
 * Transition a session to `completed` — the F4.5 accept→submit write path, now routed
 * through {@link transitionSession} so it writes a `completed` event. Idempotent
 * (re-completing a completed session is a no-op that writes no second event).
 * Re-exported from `answer-slots.ts` so the `/complete` route's import is unchanged.
 */
export function markSessionCompleted(
  sessionId: string,
  opts?: TransitionOptions
): Promise<SessionStatus> {
  return transitionSession(sessionId, 'completed', opts);
}

/** Which cost-cap threshold a `cost_cap_reached` event marks (F6.3). */
export type CostCapTierLabel = 'soft' | 'hard';

/** The cost-cap detail recorded on a `cost_cap_reached` event. */
export interface CostCapDetail {
  /** USD spent on the session when the cap was hit. */
  spentUsd: number;
  /** The session's configured USD cap. */
  capUsd: number;
  /** Which threshold this marks — `soft` (≥90%, nudge) or `hard` (≥100%, refuse + pause). */
  tier: CostCapTierLabel;
}

/**
 * Record that a session crossed a cost-budget threshold — a non-transition event (no
 * status change), with the spend detail + `tier` on `metadata`. Fired by the F6.3 turn
 * boundary: once on the first soft crossing and once on the hard refusal. The hard-cap
 * auto-pause is a separate {@link pauseSession} call (its own `paused` event).
 */
export async function recordCostCapReached(
  sessionId: string,
  detail: CostCapDetail
): Promise<void> {
  await prisma.appQuestionnaireSessionEvent.create({
    data: {
      sessionId,
      eventType: 'cost_cap_reached',
      metadata: { spentUsd: detail.spentUsd, capUsd: detail.capUsd, tier: detail.tier },
    },
  });
}

/**
 * Persist the seriousness/abuse-gate strike count on a session (a plain column write, no event).
 * The route calls this after a turn the gate flagged; the `abandoned` event itself — when the
 * threshold is hit — is a separate {@link abandonSession} call carrying the abuse metadata.
 */
export async function persistAbuseStrikes(sessionId: string, strikes: number): Promise<void> {
  await prisma.appQuestionnaireSession.update({
    where: { id: sessionId },
    data: { abuseStrikes: strikes },
  });
}

/**
 * Persist a sensitive-disclosure capture on a session (sensitivity awareness / safeguarding):
 * set the running-max `sensitivityLevel` and append one careful, non-graphic {@link SensitivityNote}
 * to the append-only `sensitivityNotes` JSON array. Read-modify-write inside a transaction so a
 * concurrent turn can't drop a note (respondent turns are serial, but the transaction is cheap
 * insurance). Plain column write — the `sensitivity_flagged` audit event is a separate
 * {@link recordSensitivityFlagged} call. Best-effort at the call site, like {@link persistAbuseStrikes}.
 */
export async function persistSensitivity(
  sessionId: string,
  level: SensitivitySeverity,
  note: SensitivityNote
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { sensitivityNotes: true },
    });
    const existing = Array.isArray(row?.sensitivityNotes)
      ? (row.sensitivityNotes as unknown as SensitivityNote[])
      : [];
    await tx.appQuestionnaireSession.update({
      where: { id: sessionId },
      data: {
        sensitivityLevel: level,
        sensitivityNotes: [...existing, note] as unknown as Prisma.InputJsonValue,
      },
    });
  });
}

/**
 * Record that a sensitive disclosure was flagged this turn — a non-transition event (no status
 * change), mirroring {@link recordCostCapReached}. Metadata carries ONLY `{ severity, category }`
 * — never the summary, which restates personal/distressing content (PII discipline).
 */
export async function recordSensitivityFlagged(
  sessionId: string,
  detail: { severity: SensitivitySeverity; category: string }
): Promise<void> {
  await prisma.appQuestionnaireSessionEvent.create({
    data: {
      sessionId,
      eventType: SENSITIVITY_FLAGGED_EVENT,
      metadata: { severity: detail.severity, category: detail.category },
    },
  });
}

/**
 * Whether a `cost_cap_reached` event of the given `tier` has already been written for this
 * session — used by the turn boundary to fire the soft-cap event only once (the soft tier
 * persists across every turn between 90% and 100%, so a naive write would spam the audit
 * trail). Reads `metadata.tier` via a JSON-path filter.
 */
export async function hasCostCapReachedEvent(
  sessionId: string,
  tier: CostCapTierLabel
): Promise<boolean> {
  const existing = await prisma.appQuestionnaireSessionEvent.findFirst({
    where: {
      sessionId,
      eventType: 'cost_cap_reached',
      metadata: { path: ['tier'], equals: tier },
    },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Record the `created` event for a freshly-born real respondent session (F6.1) — the
 * non-transition marker reserved for when a real session is created (the preview singleton
 * never fires it). `fromStatus` is null (no prior status); `toStatus` is `active`. The
 * session row itself is created by the caller in the same transaction; pass `tx` so the
 * row and its birth event commit together.
 */
export async function recordSessionCreated(
  sessionId: string,
  opts: { tx?: Prisma.TransactionClient; reason?: string } = {}
): Promise<void> {
  const db = opts.tx ?? prisma;
  await db.appQuestionnaireSessionEvent.create({
    data: {
      sessionId,
      eventType: 'created',
      toStatus: 'active',
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    },
  });
}

/** One answered slot in a session's resume state. */
export interface ResumeAnswerView {
  slotKey: string;
  value: Prisma.JsonValue;
  provenance: AnswerProvenance;
  confidence: number | null;
}

/** What a caller needs to pick up a session where it left off. */
export interface SessionResumeState {
  status: SessionStatus;
  answeredSlots: ResumeAnswerView[];
}

/**
 * Load a session's resume state: its status plus the answers captured so far (keyed by
 * slot). Intentionally minimal — coverage / next-question stay in the F4.1/F4.5 context
 * builders the caller already uses, and the per-turn history is F6.1's. Throws
 * {@link NotFoundError} if the session id doesn't resolve.
 */
export async function loadSessionResumeState(sessionId: string): Promise<SessionResumeState> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      answers: {
        select: {
          value: true,
          provenanceLabel: true,
          confidence: true,
          questionSlot: { select: { key: true } },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('Session not found');

  return {
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    answeredSlots: row.answers.map((a) => ({
      slotKey: a.questionSlot.key,
      value: a.value,
      provenance: narrowToEnum(a.provenanceLabel, ANSWER_PROVENANCES, 'direct'),
      confidence: a.confidence,
    })),
  };
}
