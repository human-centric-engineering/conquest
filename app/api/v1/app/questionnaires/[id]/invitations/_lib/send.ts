/**
 * Invitation send seam (F3.2). Route-local DB + email glue shared by the create
 * (`POST …/invitations`) and resend (`POST …/invitations/:id/resend`) handlers:
 * resolve the launched version, the app-layer `(version, email)` dedup, the opaque
 * acceptance URL, and the email send. Kept out of `lib/app/questionnaire/**` because
 * it touches Prisma + the email client.
 */

import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { sendEmail, type SendEmailResult } from '@/lib/email/send';
import QuestionnaireInvitationEmail from '@/emails/questionnaire-invitation';
import { INVITATION_BLOCKER_STATUSES } from '@/lib/app/questionnaire/invitations';

/**
 * Public path of the respondent acceptance page (built in F3.2 PR2). The opaque
 * token is the only query param — the email is derived server-side from the row.
 */
export const INVITATION_ACCEPT_PATH = '/questionnaire-invite';

/** Absolute acceptance URL for an invitation token. */
export function buildInvitationUrl(token: string): string {
  const base = env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
  return `${base}${INVITATION_ACCEPT_PATH}?token=${token}`;
}

export interface LaunchedVersionTarget {
  versionId: string;
  versionNumber: number;
  questionnaireTitle: string;
}

/**
 * The questionnaire's currently-launched version (newest if more than one ever
 * carries `launched`). `null` → the route returns `409 INVITE_NO_LAUNCHED_VERSION`:
 * you can only invite respondents to a launched version.
 */
export async function resolveLaunchedVersion(
  questionnaireId: string
): Promise<LaunchedVersionTarget | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { questionnaireId, status: 'launched' },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, versionNumber: true, questionnaire: { select: { title: true } } },
  });
  if (!version) return null;
  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    questionnaireTitle: version.questionnaire.title,
  };
}

/**
 * App-layer dedup: an existing live (non-revoked, non-terminal) invitation for this
 * `(versionId, email)`. There's no DB unique — revoke → re-invite must work — so a
 * second invite to a still-live address is a no-op `skipped`, not a 409.
 */
export async function findLiveInvitation(
  versionId: string,
  email: string
): Promise<{ id: string } | null> {
  return prisma.appQuestionnaireInvitation.findFirst({
    where: { versionId, email, status: { in: [...INVITATION_BLOCKER_STATUSES] } },
    select: { id: true },
  });
}

export interface SendInvitationEmailArgs {
  to: string;
  inviteeName: string | null;
  questionnaireTitle: string;
  token: string;
  expiresAt: Date;
}

/** Render + send the questionnaire-invitation email. Non-blocking: returns the result. */
export function sendInvitationEmail(args: SendInvitationEmailArgs): Promise<SendEmailResult> {
  return sendEmail({
    to: args.to,
    subject: `You're invited to complete ${args.questionnaireTitle}`,
    react: QuestionnaireInvitationEmail({
      inviteeName: args.inviteeName,
      questionnaireTitle: args.questionnaireTitle,
      invitationUrl: buildInvitationUrl(args.token),
      expiresAt: args.expiresAt,
    }),
  });
}
