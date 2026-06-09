/**
 * Pre-create start context for the authenticated respondent surface (F8.3).
 *
 * The `start` server component normally creates/resumes a session and redirects straight
 * to the chat. When the questionnaire collects a respondent profile (non-anonymous, with
 * `profileFields`) and the caller has no session yet, we must instead show the profile
 * form FIRST, then create the session with the collected values. This read-only resolver
 * decides which of those three things to do, without writing anything.
 *
 * Only the invitation surface collects a profile — the version-direct surface is the
 * anonymous "anyone may answer" path, which never collects one. Server-only.
 */

import { prisma } from '@/lib/db/client';
import { hashInvitationToken } from '@/lib/app/questionnaire/invitations';
import { parseProfileFields } from '@/lib/app/questionnaire/profile/profile-values';
import { findResumableSession } from '@/lib/app/questionnaire/chat/resumable-session';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';
import type { AuthedSessionRequest } from '@/lib/app/questionnaire/chat/session-bootstrap';

export type StartContext =
  /** A resumable session already exists — skip the form and go straight to chat. */
  | { kind: 'resume'; sessionId: string }
  /** Non-anonymous version with profile fields and no session yet — collect first. */
  | { kind: 'needs-profile'; profileFields: ProfileFieldConfig[] }
  /** Nothing to collect — create/resume immediately (anonymous or no profile fields). */
  | { kind: 'start-now' };

/**
 * Resolve whether the `start` page should collect a profile before creating the session.
 * Any unresolvable / non-collecting case falls through to `start-now`, letting the create
 * route own validation and error reporting (this resolver never blocks the happy path).
 */
export async function loadStartContext(
  request: AuthedSessionRequest,
  respondentUserId: string
): Promise<StartContext> {
  // Only the invitation surface is non-anonymous; a version-direct request is the
  // anonymous path, which never collects a profile.
  if (!('invitationToken' in request)) return { kind: 'start-now' };

  const invitation = await prisma.appQuestionnaireInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(request.invitationToken) },
    select: {
      versionId: true,
      version: { select: { config: { select: { anonymousMode: true, profileFields: true } } } },
    },
  });
  if (!invitation) return { kind: 'start-now' };

  const anonymous = invitation.version.config?.anonymousMode ?? false;
  const profileFields = parseProfileFields(invitation.version.config?.profileFields);
  if (anonymous || profileFields.length === 0) return { kind: 'start-now' };

  const existing = await findResumableSession(invitation.versionId, respondentUserId);
  if (existing) return { kind: 'resume', sessionId: existing.id };

  return { kind: 'needs-profile', profileFields };
}
