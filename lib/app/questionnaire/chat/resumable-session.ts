/**
 * The single definition of a respondent's "resumable" session (F8.3).
 *
 * A respondent resumes — rather than starts afresh — when they already have a
 * non-preview, non-terminal session for the version. Both the create route
 * (`questionnaire-sessions/_lib/create.ts`) and the pre-create resolver
 * (`chat/start-context.ts`) must agree on this rule, or the start page would redirect
 * to a session the create route wouldn't resume (or vice-versa). Keep it here so the
 * rule lives in one place. Server-only.
 */

import { prisma } from '@/lib/db/client';

/** A resumable session's identifying fields. */
export interface ResumableSession {
  id: string;
  status: string;
  versionId: string;
}

/**
 * Find a respondent's existing non-terminal real session for a version (the resume
 * target), or null if none. Most-recent first; preview sessions are excluded.
 */
export async function findResumableSession(
  versionId: string,
  respondentUserId: string,
  roundId?: string | null
): Promise<ResumableSession | null> {
  return prisma.appQuestionnaireSession.findFirst({
    where: {
      versionId,
      respondentUserId,
      isPreview: false,
      status: { in: ['active', 'paused'] },
      // Cohorts & Rounds: resume must be round-scoped. A non-round start (roundId undefined)
      // matches only non-round sessions (roundId null); a round start matches the SAME round —
      // so a closed round can't resume a stale session and two rounds keep separate sessions.
      roundId: roundId ?? null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, versionId: true },
  });
}

/**
 * Find the non-terminal session a frictionless invitee already booted from their invitation (the
 * resume target keyed on `invitationId`, since a no-account respondent has no `respondentUserId`).
 * Lets a re-opened invite link resume rather than minting a second session. Most-recent first.
 */
export async function findResumableSessionByInvitation(
  invitationId: string,
  roundId?: string | null
): Promise<ResumableSession | null> {
  return prisma.appQuestionnaireSession.findFirst({
    where: {
      invitationId,
      isPreview: false,
      status: { in: ['active', 'paused'] },
      // Round-scoped resume (see findResumableSession) — keep a per-round session distinct.
      roundId: roundId ?? null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, versionId: true },
  });
}
