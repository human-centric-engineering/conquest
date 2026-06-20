/**
 * Cohorts & Rounds — the DB-loading wrapper around the pure round access guard.
 *
 * A session carrying a `roundId` is time-bound; one without it is never gated and never
 * reaches here. This wrapper loads the round + (optional) cohort member + whether the
 * session's questionnaire is actually bundled in the round, then delegates the decision to
 * the pure {@link evaluateRoundAccess}. It lives in the route `_lib` (not `lib/app/**`)
 * because it touches Prisma; the verdict shape mirrors the session-create typed-rejection
 * union so callers map it straight to `errorResponse`.
 *
 * `onMissingRound` differs by phase: at CREATE a missing round id is a bad reference (deny
 * 404); at CONTINUE a since-deleted round simply stops gating (allow) — the session keeps
 * its history.
 */

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  evaluateRoundAccess,
  type RoundAccessVerdict,
} from '@/lib/app/questionnaire/rounds/access';
import {
  COHORT_MEMBER_STATUSES,
  ROUND_STATUSES,
  type CohortMemberStatus,
} from '@/lib/app/questionnaire/rounds/types';

/** Loose verdict — the pure denial codes plus `ROUND_NOT_FOUND` (create-only). */
export type RoundAccessResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

export interface AssertRoundAccessInput {
  roundId: string;
  /** The cohort member the session belongs to, or null (round window still applies). */
  cohortMemberId: string | null;
  /** The version the session runs — used to resolve the questionnaire-in-round check. */
  versionId: string;
  /** What to do when the round row is gone: 'deny' (create) | 'allow' (continue). */
  onMissingRound: 'deny' | 'allow';
  /** Evaluation instant (defaults to now). */
  now?: Date;
}

export async function assertRoundAccess(input: AssertRoundAccessInput): Promise<RoundAccessResult> {
  const now = input.now ?? new Date();

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: input.roundId },
    select: {
      status: true,
      opensAt: true,
      closesAt: true,
      cohortId: true,
      items: { select: { questionnaireId: true } },
    },
  });

  if (!round) {
    if (input.onMissingRound === 'allow') return { ok: true };
    return { ok: false, status: 404, code: 'ROUND_NOT_FOUND', message: 'Round not found' };
  }

  // The session's questionnaire must be one the round bundles (resolved through the version).
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: input.versionId },
    select: { questionnaireId: true },
  });
  const questionnaireInRound = version
    ? round.items.some((it) => it.questionnaireId === version.questionnaireId)
    : false;

  // Member resolution: a missing member, or one from a DIFFERENT cohort than the round's,
  // is treated as removed (it can't be a legitimate member of this round).
  let member: { status: CohortMemberStatus } | null = null;
  if (input.cohortMemberId) {
    const m = await prisma.appCohortMember.findUnique({
      where: { id: input.cohortMemberId },
      select: { status: true, cohortId: true },
    });
    member =
      m && m.cohortId === round.cohortId
        ? { status: narrowToEnum(m.status, COHORT_MEMBER_STATUSES, 'active') }
        : { status: 'removed' };
  }

  const verdict: RoundAccessVerdict = evaluateRoundAccess({
    round: {
      status: narrowToEnum(round.status, ROUND_STATUSES, 'draft'),
      opensAt: round.opensAt,
      closesAt: round.closesAt,
    },
    member,
    questionnaireInRound,
    now,
  });
  return verdict;
}
