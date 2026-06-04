/**
 * Single questionnaire invitation endpoint (F3.2).
 *
 * PATCH /api/v1/app/questionnaires/:id/invitations/:invitationId
 *   Admin-only revoke. The only mutation here today; the body is `{ action: "revoke" }`
 *   to leave room for future actions without a new verb. Revoke is legal only from
 *   pending | sent | opened (a registered/terminal invitation can't be revoked) —
 *   enforced by the pure transition guard. Once revoked the invitation stops pinning
 *   its version (it drops out of the launch-blocker count).
 *
 * Flag-gate first (404 when off), then `withAdminAuth`. Audited.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { isInvitationTransitionAllowed } from '@/lib/app/questionnaire/invitations';
import {
  loadScopedInvitation,
  toInvitationView,
  INVITATION_SELECT,
} from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/read';

const patchInvitationSchema = z.object({ action: z.literal('revoke') });

type Params = { id: string; invitationId: string };

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, invitationId } = await params;

  const scoped = await loadScopedInvitation(id, invitationId);
  if (!scoped) {
    return errorResponse('Invitation not found', { code: 'NOT_FOUND', status: 404 });
  }

  await validateRequestBody(request, patchInvitationSchema);

  if (!isInvitationTransitionAllowed(scoped.status, 'revoked')) {
    return errorResponse(`Cannot revoke an invitation in status "${scoped.status}"`, {
      code: 'INVITATION_NOT_REVOCABLE',
      status: 409,
    });
  }

  const updated = await prisma.appQuestionnaireInvitation.update({
    where: { id: invitationId },
    data: { status: 'revoked', revokedAt: new Date() },
    select: INVITATION_SELECT,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_invitation.revoke',
    entityType: 'questionnaire_invitation',
    entityId: invitationId,
    changes: computeChanges({ status: scoped.status }, { status: 'revoked' }),
    clientIp,
  });
  log.info('Invitation revoked', { questionnaireId: id, invitationId });

  return successResponse(toInvitationView(updated));
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<Params> }
): Promise<Response> {
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handlePatch(request, context);
}
