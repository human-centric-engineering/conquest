/**
 * Invitation read models (F3.2). Route-local DB seam — `lib/app/questionnaire/**`
 * is Prisma-free, so the queries live here. Invitations are scoped to a
 * questionnaire **through the version relation** (`version.questionnaireId`); there
 * is no `questionnaireId` column on the invitation (the FK pins the version).
 *
 * `INVITATION_SELECT` deliberately omits `tokenHash` — no read path ever projects
 * the token material.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import type { AppInvitationStatus } from '@/lib/app/questionnaire/invitations';
import type { InvitationView } from '@/lib/app/questionnaire/invitations';

/** Column set behind every invitation view — identity + lifecycle, never `tokenHash`. */
export const INVITATION_SELECT = {
  id: true,
  email: true,
  name: true,
  status: true,
  versionId: true,
  expiresAt: true,
  sentAt: true,
  openedAt: true,
  registeredAt: true,
  revokedAt: true,
  createdAt: true,
  version: { select: { versionNumber: true } },
} as const;

type InvitationRow = Prisma.AppQuestionnaireInvitationGetPayload<{
  select: typeof INVITATION_SELECT;
}>;

/** Project an `INVITATION_SELECT` row to the client-safe view (ISO dates, flattened version). */
export function toInvitationView(row: InvitationRow): InvitationView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status as AppInvitationStatus,
    versionId: row.versionId,
    versionNumber: row.version.versionNumber,
    expiresAt: row.expiresAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    openedAt: row.openedAt?.toISOString() ?? null,
    registeredAt: row.registeredAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListInvitationsOptions {
  status?: AppInvitationStatus;
  page?: number;
  limit?: number;
}

/** Invitations for a questionnaire (across its launched versions), newest-first, paginated. */
export async function listInvitations(
  questionnaireId: string,
  options: ListInvitationsOptions = {}
): Promise<{ invitations: InvitationView[]; total: number }> {
  const { status, page = 1, limit = 50 } = options;
  const where: Prisma.AppQuestionnaireInvitationWhereInput = {
    version: { questionnaireId },
    ...(status ? { status } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.appQuestionnaireInvitation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: INVITATION_SELECT,
    }),
    prisma.appQuestionnaireInvitation.count({ where }),
  ]);

  return { invitations: rows.map(toInvitationView), total };
}

/** The minimal facts a revoke/resend route needs, scoped to the parent questionnaire. */
export interface ScopedInvitation {
  id: string;
  versionId: string;
  email: string;
  name: string | null;
  status: AppInvitationStatus;
  /** Title of the questionnaire the invitation's pinned version belongs to (for the email). */
  questionnaireTitle: string;
}

/**
 * Load an invitation scoped to its parent questionnaire (via the version relation).
 * Returns `null` (→ route 404) when the id/questionnaire pair doesn't resolve, so an
 * invitation can't leak across questionnaires. Carries the title of the invitation's
 * **own** pinned version's questionnaire (one join, no extra round-trip) so resend
 * emails the questionnaire the respondent was actually invited to — not whatever is
 * launched now.
 */
export async function loadScopedInvitation(
  questionnaireId: string,
  invitationId: string
): Promise<ScopedInvitation | null> {
  const row = await prisma.appQuestionnaireInvitation.findFirst({
    where: { id: invitationId, version: { questionnaireId } },
    select: {
      id: true,
      versionId: true,
      email: true,
      name: true,
      status: true,
      version: { select: { questionnaire: { select: { title: true } } } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.versionId,
    email: row.email,
    name: row.name,
    status: row.status as AppInvitationStatus,
    questionnaireTitle: row.version.questionnaire.title,
  };
}
