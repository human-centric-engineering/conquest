/**
 * The single definition of a respondent's "resumable" session (F8.3).
 *
 * A respondent resumes — rather than starts afresh — when they already have a
 * non-preview, non-terminal session for the version. The create route
 * (`questionnaire-sessions/_lib/create.ts`) is the single caller and owns this rule
 * (the `/start` page just delegates to it, resuming idempotently). Keep it here so the
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
 * A resumable session enriched for the authenticated "Continue where you left off / Start new"
 * chooser: its support ref (for the header) and how many answers it already holds (to decide the
 * chooser is worth showing — a zero-progress session resumes silently, like the anonymous gate).
 */
export interface AuthedResumeDetail {
  sessionId: string;
  ref: string | null;
  answeredCount: number;
}

/**
 * Find the authenticated respondent's resumable session for a version WITH the detail the resume
 * chooser needs (ref + answered count), or null if none. Same resume rule as
 * {@link findResumableSession}; a separate reader so the plain create path stays lean.
 */
export async function findAuthedResumeDetail(
  versionId: string,
  respondentUserId: string,
  roundId?: string | null
): Promise<AuthedResumeDetail | null> {
  const row = await prisma.appQuestionnaireSession.findFirst({
    where: {
      versionId,
      respondentUserId,
      isPreview: false,
      status: { in: ['active', 'paused'] },
      roundId: roundId ?? null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, publicRef: true, _count: { select: { answers: true } } },
  });
  if (!row) return null;
  return { sessionId: row.id, ref: row.publicRef, answeredCount: row._count.answers };
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
