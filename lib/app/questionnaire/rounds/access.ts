/**
 * Cohorts & Rounds — the respondent access guard (pure).
 *
 * A round is the ONLY thing that makes a questionnaire time-bound. When a session carries a
 * `roundId`, both starting it and continuing it must pass this gate; a session with no
 * `roundId` is never time-bound and never reaches here. The check is deliberately PURE — it
 * takes already-loaded round/member facts and returns a verdict — so it unit-tests as a
 * matrix and the DB-loading wrapper lives in the route `_lib` (keeping `lib/app/**`
 * Prisma-free, the house boundary).
 *
 * The verdict mirrors the session-create typed-rejection union
 * (`{ ok: false; status; code; message }`) so callers map it straight to `errorResponse`.
 */

import type { CohortMemberStatus, RoundStatus } from '@/lib/app/questionnaire/rounds/types';

/** Denial codes — stable contract for callers + tests. */
export type RoundAccessDenialCode =
  | 'QUESTIONNAIRE_NOT_IN_ROUND'
  | 'ROUND_NOT_OPEN'
  | 'ROUND_WINDOW_CLOSED'
  | 'COHORT_MEMBER_REMOVED';

/** The already-loaded facts the gate decides on. */
export interface RoundAccessSubject {
  /** The round the session runs within. */
  round: {
    status: RoundStatus;
    /** Window start; null = no lower bound (open as soon as status flips to `open`). */
    opensAt: Date | null;
    /** Window end; null = no upper bound (open until manually closed). */
    closesAt: Date | null;
  };
  /**
   * The cohort member the session belongs to, or null when the session carries a `roundId`
   * but no `cohortMemberId` (e.g. a future shared-link grant). Member checks are skipped
   * when null — the round window still applies.
   */
  member: { status: CohortMemberStatus } | null;
  /** Whether the session's questionnaire is actually bundled in this round. */
  questionnaireInRound: boolean;
  /** Evaluation instant (injected, never read from the clock here — keeps the gate pure). */
  now: Date;
}

export type RoundAccessVerdict =
  | { ok: true }
  | { ok: false; status: number; code: RoundAccessDenialCode; message: string };

/**
 * Decide whether a respondent may start/continue a session within a round.
 *
 * Order is deliberate (most structural first):
 *  1. the questionnaire must belong to the round at all;
 *  2. the round must be in `open` status (not draft, not closed);
 *  3. now must be inside the window — before `opensAt` reads as not-yet-open, after
 *     `closesAt` as window-closed (the window enforces the time-bound independently of the
 *     status flag, so an `open` round whose `closesAt` has passed still denies);
 *  4. the member, when known, must not be removed.
 */
export function evaluateRoundAccess(subject: RoundAccessSubject): RoundAccessVerdict {
  const { round, member, questionnaireInRound, now } = subject;

  if (!questionnaireInRound) {
    return {
      ok: false,
      status: 409,
      code: 'QUESTIONNAIRE_NOT_IN_ROUND',
      message: 'This questionnaire is not part of the round.',
    };
  }

  if (round.status !== 'open') {
    return {
      ok: false,
      status: 409,
      code: 'ROUND_NOT_OPEN',
      message:
        round.status === 'closed' ? 'This round has closed.' : 'This round has not opened yet.',
    };
  }

  const ms = now.getTime();
  if (round.opensAt && ms < round.opensAt.getTime()) {
    return {
      ok: false,
      status: 409,
      code: 'ROUND_NOT_OPEN',
      message: 'This round has not opened yet.',
    };
  }
  if (round.closesAt && ms > round.closesAt.getTime()) {
    return {
      ok: false,
      status: 409,
      code: 'ROUND_WINDOW_CLOSED',
      message: 'This round has closed.',
    };
  }

  if (member && member.status === 'removed') {
    return {
      ok: false,
      status: 403,
      code: 'COHORT_MEMBER_REMOVED',
      message: 'You are no longer a member of this round.',
    };
  }

  return { ok: true };
}
