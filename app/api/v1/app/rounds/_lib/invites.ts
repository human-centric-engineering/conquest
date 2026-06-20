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
 * round binding. The token expiry is pinned to the round's `closesAt` when set (the link dies
 * with the round), else the default invitation expiry.
 *
 * Idempotent: a member who already has an invitation for a (version, round) pair is skipped, so
 * re-running after adding members tops up the roster without duplicating links.
 */

import { prisma } from '@/lib/db/client';
import { mintInvitationToken } from '@/lib/app/questionnaire/invitations/token';

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

/** Resolve the version to invite to for a round item: the pin, else the current launched version. */
async function resolveItemVersionId(item: {
  questionnaireId: string;
  versionId: string | null;
}): Promise<string | null> {
  if (item.versionId) return item.versionId;
  const launched = await prisma.appQuestionnaireVersion.findFirst({
    where: { questionnaireId: item.questionnaireId, status: 'launched' },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  });
  return launched?.id ?? null;
}

/**
 * Generate (top up) the round's per-member invitations. Returns counts + the newly-minted links.
 * A round that isn't usable yet (no items, no active members, no launched versions) simply
 * returns zero `created` — never throws.
 */
export async function generateRoundInvitations(
  roundId: string,
  invitedByUserId: string
): Promise<GenerateRoundInvitesResult> {
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: {
      id: true,
      closesAt: true,
      cohort: { select: { demoClientId: true } },
      items: { select: { questionnaireId: true, versionId: true } },
    },
  });
  if (!round) {
    return { created: 0, skipped: 0, unlaunchedQuestionnaires: 0, activeMembers: 0, links: [] };
  }

  // Active members of the round's cohort (reached via the round → cohort relation).
  const activeMembers = await prisma.appCohortMember.findMany({
    where: { cohort: { rounds: { some: { id: roundId } } }, status: 'active' },
    select: { id: true, email: true, name: true },
  });

  const demoClientId = round.cohort.demoClientId;
  const result: GenerateRoundInvitesResult = {
    created: 0,
    skipped: 0,
    unlaunchedQuestionnaires: 0,
    activeMembers: activeMembers.length,
    links: [],
  };

  for (const item of round.items) {
    const versionId = await resolveItemVersionId(item);
    if (!versionId) {
      result.unlaunchedQuestionnaires += 1;
      continue;
    }

    for (const member of activeMembers) {
      // Idempotent: one invitation per (version, round, member).
      const existing = await prisma.appQuestionnaireInvitation.findFirst({
        where: { versionId, roundId, cohortMemberId: member.id },
        select: { id: true },
      });
      if (existing) {
        result.skipped += 1;
        continue;
      }

      const minted = mintInvitationToken();
      const expiresAt = round.closesAt ?? minted.expiresAt;
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
          expiresAt,
        },
        select: { id: true },
      });

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
