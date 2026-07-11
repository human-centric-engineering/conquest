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
import { isRoundPhasesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  evaluateRoundAccess,
  type RoundAccessVerdict,
} from '@/lib/app/questionnaire/rounds/access';
import type { PhaseWindow } from '@/lib/app/questionnaire/rounds/phases';
import {
  COHORT_MEMBER_STATUSES,
  ROUND_PHASE_END_MODES,
  ROUND_STATUSES,
  type CohortMemberStatus,
} from '@/lib/app/questionnaire/rounds/types';

/** Loose verdict — the pure denial codes plus `ROUND_NOT_FOUND` (create-only). */
export type RoundAccessResult =
  { ok: true } | { ok: false; status: number; code: string; message: string };

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

/**
 * The cohort SUBGROUP a member currently belongs to (or null) — snapshot onto the session at create
 * so per-phase completion stats group without a member join and survive later roster edits. Resolved
 * independently of the round-phases flag: the assignment is plain roster config, harmless to record.
 */
export async function resolveCohortSubgroupId(
  cohortMemberId: string | null
): Promise<string | null> {
  if (!cohortMemberId) return null;
  const m = await prisma.appCohortMember.findUnique({
    where: { id: cohortMemberId },
    select: { subgroupId: true },
  });
  return m?.subgroupId ?? null;
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
  // is treated as removed (it can't be a legitimate member of this round). We also read the
  // member's subgroup, so a staggered phase window can apply.
  let member: { status: CohortMemberStatus } | null = null;
  let subgroupId: string | null = null;
  if (input.cohortMemberId) {
    const m = await prisma.appCohortMember.findUnique({
      where: { id: input.cohortMemberId },
      select: { status: true, cohortId: true, subgroupId: true },
    });
    if (m && m.cohortId === round.cohortId) {
      member = { status: narrowToEnum(m.status, COHORT_MEMBER_STATUSES, 'active') };
      subgroupId = m.subgroupId;
    } else {
      member = { status: 'removed' };
    }
  }

  // Phase resolution (feature-flagged): the member's subgroup may have a staggered window on this
  // round. When the flag is off, or the member has no subgroup / no phase, `phase` stays null and the
  // round's own window applies — today's behaviour.
  let phase: PhaseWindow | null = null;
  if (subgroupId && (await isRoundPhasesEnabled())) {
    const p = await prisma.appRoundPhase.findUnique({
      where: { roundId_subgroupId: { roundId: input.roundId, subgroupId } },
      select: { opensAt: true, closesAt: true, endMode: true },
    });
    if (p) {
      phase = {
        opensAt: p.opensAt,
        closesAt: p.closesAt,
        endMode: narrowToEnum(p.endMode, ROUND_PHASE_END_MODES, 'hard'),
      };
    }
  }

  const verdict: RoundAccessVerdict = evaluateRoundAccess({
    round: {
      status: narrowToEnum(round.status, ROUND_STATUSES, 'draft'),
      opensAt: round.opensAt,
      closesAt: round.closesAt,
    },
    member,
    phase,
    questionnaireInRound,
    now,
  });
  return verdict;
}
