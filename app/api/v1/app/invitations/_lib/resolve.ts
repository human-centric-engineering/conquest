/**
 * Token resolution for the public respondent invitation endpoints (F3.2 PR2).
 * Route-local DB seam (the `lib/app/questionnaire/**` module is Prisma-free).
 *
 * The respondent's link carries only an opaque `?token=`; we hash it and match
 * `tokenHash`, deriving the email + questionnaire title server-side. A resolution
 * is a discriminated union so the routes map each failure to the right status
 * (404 unknown · 410 expired/revoked) without leaking which one to a guesser beyond
 * the coarse reason.
 */

import { prisma } from '@/lib/db/client';
import { errorResponse } from '@/lib/api/responses';
import { type AppInvitationStatus } from '@/lib/app/questionnaire/invitations';
import { hashInvitationToken } from '@/lib/app/questionnaire/invitations/token';

export interface ResolvedInvitation {
  id: string;
  email: string;
  name: string | null;
  status: AppInvitationStatus;
  versionId: string;
  questionnaireTitle: string;
  expiresAt: Date;
  openedAt: Date | null;
  /** Respondent account bound at registration; null for an unbound (incl. frictionless) invite. */
  userId: string | null;
}

export type InvitationResolution =
  | { ok: true; invitation: ResolvedInvitation }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' };

/** Resolve an invitation from its plaintext token, classifying invalid states. */
export async function resolveInvitationByToken(token: string): Promise<InvitationResolution> {
  const tokenHash = hashInvitationToken(token);
  const row = await prisma.appQuestionnaireInvitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      versionId: true,
      expiresAt: true,
      openedAt: true,
      userId: true,
      version: { select: { questionnaire: { select: { title: true } } } },
    },
  });

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    invitation: {
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status as AppInvitationStatus,
      versionId: row.versionId,
      questionnaireTitle: row.version.questionnaire.title,
      expiresAt: row.expiresAt,
      openedAt: row.openedAt,
      userId: row.userId,
    },
  };
}

/**
 * Map a failed {@link InvitationResolution} to its HTTP response — shared by the
 * metadata + accept routes so the unknown-token (404) and expired/revoked (410)
 * envelopes never drift between the two public surfaces.
 */
export function resolutionErrorResponse(reason: 'not_found' | 'expired' | 'revoked'): Response {
  if (reason === 'not_found') {
    return errorResponse('Invitation not found', { code: 'NOT_FOUND', status: 404 });
  }
  return errorResponse(
    reason === 'expired' ? 'This invitation has expired' : 'This invitation was revoked',
    {
      code: reason === 'expired' ? 'INVITATION_EXPIRED' : 'INVITATION_REVOKED',
      status: 410,
    }
  );
}
