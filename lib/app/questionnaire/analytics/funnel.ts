/**
 * Completion funnel (F8.1): invited → opened → started → completed, with drop-off.
 *
 * The invite stages come from `AppQuestionnaireInvitation` timestamps (set reliably
 * by F3.2: `sentAt`, `openedAt`). The downstream stages are derived from real
 * session data rather than the invitation's `status` string, so the funnel reflects
 * what respondents actually did: an invited respondent is "started" once they have a
 * non-preview session for the version, and "completed" once one of those sessions
 * reaches `completed`. Respondents are matched to invitations by `userId`
 * (set on registration) — the only link between the two (no FK, UG-1).
 *
 * Anonymous / public-link sessions have no invitation, so they can't enter the
 * invite funnel; they're reported separately (entering at "started") to avoid
 * overstating invited-stage drop-off.
 */

import { prisma } from '@/lib/db/client';
import { isCohortSuppressed } from '@/lib/app/questionnaire/analytics/privacy';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  CompletionFunnelResult,
  FunnelStage,
  FunnelStageKey,
} from '@/lib/app/questionnaire/analytics/views';

const STAGE_LABELS: Record<FunnelStageKey, string> = {
  invited: 'Invited',
  opened: 'Opened',
  started: 'Started',
  completed: 'Completed',
};

/** Build the ordered stage list with drop-off, retention, and step conversion. */
function buildStages(counts: Record<FunnelStageKey, number>): FunnelStage[] {
  const order: FunnelStageKey[] = ['invited', 'opened', 'started', 'completed'];
  const base = counts.invited;
  let prev = counts.invited;
  return order.map((key, i) => {
    const count = counts[key];
    const stage: FunnelStage = {
      key,
      label: STAGE_LABELS[key],
      count,
      dropoff: i === 0 ? 0 : Math.max(0, prev - count),
      retention: base > 0 ? count / base : 0,
      conversionFromPrev: i === 0 ? 1 : prev > 0 ? count / prev : 0,
    };
    prev = count;
    return stage;
  });
}

/**
 * Compute the completion funnel for a version over the date window. Invitations are
 * scoped by `createdAt`; sessions by `createdAt` and `isPreview = false`.
 */
export async function getCompletionFunnel(scope: AnalyticsScope): Promise<CompletionFunnelResult> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  // Invitations in scope, excluding revoked. `userId` links to the respondent.
  const invitations = await prisma.appQuestionnaireInvitation.findMany({
    where: {
      versionId: scope.versionId,
      createdAt: { gte: scope.from, lt: scope.to },
      revokedAt: null,
    },
    select: { sentAt: true, openedAt: true, userId: true },
  });

  // Non-preview sessions in scope, grouped by respondent.
  const sessions = await prisma.appQuestionnaireSession.findMany({
    where: {
      versionId: scope.versionId,
      isPreview: false,
      createdAt: { gte: scope.from, lt: scope.to },
    },
    select: { respondentUserId: true, status: true },
  });

  // Which respondents have any session / a completed session.
  const startedUsers = new Set<string>();
  const completedUsers = new Set<string>();
  for (const s of sessions) {
    if (!s.respondentUserId) continue;
    startedUsers.add(s.respondentUserId);
    if (s.status === 'completed') completedUsers.add(s.respondentUserId);
  }

  const invitedUserIds = new Set(
    invitations.map((i) => i.userId).filter((id): id is string => id !== null)
  );

  const invited = invitations.filter((i) => i.sentAt !== null).length;
  const opened = invitations.filter((i) => i.openedAt !== null).length;
  let started = 0;
  let completed = 0;
  for (const userId of invitedUserIds) {
    if (startedUsers.has(userId)) started += 1;
    if (completedUsers.has(userId)) completed += 1;
  }

  // Anonymous sessions: those whose respondent was never invited (incl. no userId).
  let anonStarted = 0;
  let anonCompleted = 0;
  for (const s of sessions) {
    const invitedRespondent = s.respondentUserId !== null && invitedUserIds.has(s.respondentUserId);
    if (invitedRespondent) continue;
    anonStarted += 1;
    if (s.status === 'completed') anonCompleted += 1;
  }

  // F8.3: the funnel output is counts-only (no respondent identity ever crosses the
  // boundary), so the only re-identification risk is a tiny cohort — knowing "1 of 2
  // invitees completed" plus the invitee list pinpoints a person. Suppress every count
  // when the participant cohort is non-empty but below the k-anonymity threshold. The
  // cohort is the population the stages actually describe — invitations that were SENT
  // (`invited`) plus anonymous starts — not raw invitation rows, so a batch of unsent
  // (draft) invitations neither pads the count past the floor nor trips suppression on
  // an otherwise-empty funnel.
  const cohortSize = invited + anonStarted;
  const suppressed = isCohortSuppressed(cohortSize);

  const counts = suppressed
    ? { invited: 0, opened: 0, started: 0, completed: 0 }
    : { invited, opened, started, completed };

  return {
    versionId: scope.versionId,
    range,
    stages: buildStages(counts),
    anonymous: suppressed
      ? { started: 0, completed: 0 }
      : { started: anonStarted, completed: anonCompleted },
    suppressed,
  };
}
