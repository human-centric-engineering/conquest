/**
 * Cohorts & Rounds — per-member round invitation generation (the grant mechanism).
 *
 * Materialises a real `AppQuestionnaireInvitation` per **active** cohort member × per
 * questionnaire-version the round bundles, stamping the round + member onto the invitation.
 * That invitation is the SERVER-TRUSTED carrier of a session's round context: the
 * session-create paths read `roundId`/`cohortMemberId` from the resolved invitation (never
 * from the client), so a respondent can't forge round membership.
 *
 * Reuses the existing invitation token machinery (`mintInvitationToken`) and the frictionless
 * link shape (`/q/[versionId]?i=<token>`), so a round invitation flows through the exact same
 * no-login session path as a regular frictionless invite — it just additionally carries the
 * round binding. The token expiry is pinned to each member's EFFECTIVE close (their subgroup
 * phase's hard close when staggered, else the round's `closesAt`) when that is in the future, so a
 * link dies with the member's actual window; otherwise it falls back to the default expiry.
 *
 * Idempotent: a member who already has an invitation for a (version, round) pair is skipped, so
 * re-running after adding members tops up the roster without duplicating links.
 */

import { prisma } from '@/lib/db/client';
import { mintInvitationToken } from '@/lib/app/questionnaire/invitations/token';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { ROUND_PHASE_END_MODES } from '@/lib/app/questionnaire/rounds/types';
import { resolveEffectiveWindow, type PhaseWindow } from '@/lib/app/questionnaire/rounds/phases';
import { resolveItemVersions } from '@/app/api/v1/app/rounds/_lib/versions';

/** One freshly-minted link returned to the admin (plaintext token — generation-time only). */
export interface MintedRoundInviteLink {
  memberId: string;
  email: string;
  name: string;
  questionnaireId: string;
  versionId: string;
  /** The frictionless no-login URL the respondent opens. */
  url: string;
}

export interface GenerateRoundInvitesResult {
  /** Invitations created this run. */
  created: number;
  /** (member, version) pairs skipped because an invitation already existed. */
  skipped: number;
  /** Round items skipped because the questionnaire has no launched version to invite to. */
  unlaunchedQuestionnaires: number;
  /** Active members at generation time. */
  activeMembers: number;
  /** The links minted this run (for the admin to copy/send). */
  links: MintedRoundInviteLink[];
}

/**
 * Generate (top up) the round's per-member invitations. Returns counts + the newly-minted links.
 * A round that isn't usable yet (no items, no active members, no launched versions) simply
 * returns zero `created` — never throws.
 *
 * Query budget is bounded regardless of cohort size: one round read, one member read, one
 * launched-version sweep, one existing-invitation sweep, then one `create` per minted link (each
 * invitation carries a unique token, so the writes can't be a single `createMany`). Idempotency
 * (skip a member already invited for a (version, round) pair) is best-effort against the loaded
 * snapshot — two concurrent generations could both create; the admin one-shot nature makes that
 * race acceptable, and a re-run simply reports the duplicates as `skipped`.
 */
export async function generateRoundInvitations(
  roundId: string,
  invitedByUserId: string
): Promise<GenerateRoundInvitesResult> {
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: {
      id: true,
      opensAt: true,
      closesAt: true,
      cohort: { select: { demoClientId: true } },
      items: { select: { questionnaireId: true, versionId: true } },
      // Staggered subgroup phases — a member's token expiry pins to THEIR effective close.
      phases: { select: { subgroupId: true, opensAt: true, closesAt: true, endMode: true } },
    },
  });
  if (!round) {
    return { created: 0, skipped: 0, unlaunchedQuestionnaires: 0, activeMembers: 0, links: [] };
  }

  // Active members of the round's cohort + each item's resolved version (both fan-outs batched).
  const [activeMembers, versionByQuestionnaire] = await Promise.all([
    prisma.appCohortMember.findMany({
      where: { cohort: { rounds: { some: { id: roundId } } }, status: 'active' },
      select: { id: true, email: true, name: true, subgroupId: true },
    }),
    resolveItemVersions(round.items),
  ]);

  // Index phases by subgroup so each member's effective close is an O(1) lookup.
  const phaseBySubgroup = new Map<string, PhaseWindow>(
    round.phases.map((p) => [
      p.subgroupId,
      {
        opensAt: p.opensAt,
        closesAt: p.closesAt,
        endMode: narrowToEnum(p.endMode, ROUND_PHASE_END_MODES, 'hard'),
      },
    ])
  );
  const roundWindow = { opensAt: round.opensAt, closesAt: round.closesAt };

  const demoClientId = round.cohort.demoClientId;
  const result: GenerateRoundInvitesResult = {
    created: 0,
    skipped: 0,
    unlaunchedQuestionnaires: 0,
    activeMembers: activeMembers.length,
    links: [],
  };

  // One sweep of the round's existing invitations → a `${versionId}:${memberId}` set for O(1)
  // idempotency checks, instead of a findFirst per (item, member) pair.
  const resolvedVersionIds = [
    ...new Set([...versionByQuestionnaire.values()].filter(Boolean)),
  ] as string[];
  const existing =
    resolvedVersionIds.length > 0
      ? await prisma.appQuestionnaireInvitation.findMany({
          where: { roundId, versionId: { in: resolvedVersionIds } },
          select: { versionId: true, cohortMemberId: true },
        })
      : [];
  const existingKeys = new Set(existing.map((e) => `${e.versionId}:${e.cohortMemberId}`));

  const now = new Date();

  // Each member's token expiry pins to THEIR effective close (the phase's hard close, else the round
  // close) — but only when it's still in the FUTURE, else a past close would mint already-expired
  // (dead-on-arrival) links. Falls back to the default invitation expiry.
  const memberWindowExpiry = (subgroupId: string | null): Date | null => {
    const phase = subgroupId ? (phaseBySubgroup.get(subgroupId) ?? null) : null;
    const effClose = resolveEffectiveWindow(roundWindow, phase).closesAt;
    return effClose && effClose.getTime() > now.getTime() ? effClose : null;
  };

  for (const item of round.items) {
    const versionId = versionByQuestionnaire.get(item.questionnaireId) ?? null;
    if (!versionId) {
      result.unlaunchedQuestionnaires += 1;
      continue;
    }

    for (const member of activeMembers) {
      if (existingKeys.has(`${versionId}:${member.id}`)) {
        result.skipped += 1;
        continue;
      }

      const minted = mintInvitationToken(now);
      await prisma.appQuestionnaireInvitation.create({
        data: {
          versionId,
          email: member.email,
          name: member.name,
          tokenHash: minted.tokenHash,
          status: 'pending',
          invitedByUserId,
          demoClientId,
          roundId,
          cohortMemberId: member.id,
          expiresAt: memberWindowExpiry(member.subgroupId) ?? minted.expiresAt,
        },
        select: { id: true },
      });
      // Guard against a duplicate questionnaire bundled twice resolving to the same version+member.
      existingKeys.add(`${versionId}:${member.id}`);

      result.created += 1;
      result.links.push({
        memberId: member.id,
        email: member.email,
        name: member.name,
        questionnaireId: item.questionnaireId,
        versionId,
        url: `/q/${versionId}?i=${minted.token}`,
      });
    }
  }

  return result;
}
