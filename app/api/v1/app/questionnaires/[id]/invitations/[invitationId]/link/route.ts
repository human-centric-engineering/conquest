/**
 * Generate a copy-able frictionless invite link (invitations Phase E).
 *
 * POST /api/v1/app/questionnaires/:id/invitations/:invitationId/link
 *   Admin-only. Mints a FRESH token (so the returned URL is usable) and returns the no-login
 *   frictionless link `/q/:versionId?i=<token>` for the admin to copy and share manually — e.g.
 *   when the invitee didn't receive the email. Does NOT send an email (unlike resend).
 *
 * ⚠️ Rotates the token: any previously emailed/copied link for this invitee STOPS WORKING. An
 * in-flight session survives (resume keys on `invitationId`, not the token); only a not-yet-opened
 * old link dies. Refused for revoked/completed invitations.
 *
 * Flag-gate first (404 when off), then `withAdminAuth`; `inviteLimiter` sub-cap + audit.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { mintInvitationToken } from '@/lib/app/questionnaire/invitations/token';
import { loadScopedInvitation } from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/read';
import { buildFrictionlessInviteUrl } from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/send';

type Params = { id: string; invitationId: string };

const handleLink = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, invitationId } = await params;

  const rateLimit = inviteLimiter.check(clientIp);
  if (!rateLimit.success) {
    log.warn('Invitation link rate limit exceeded', { questionnaireId: id, invitationId });
    return createRateLimitResponse(rateLimit);
  }

  const scoped = await loadScopedInvitation(id, invitationId);
  if (!scoped) return errorResponse('Invitation not found', { code: 'NOT_FOUND', status: 404 });

  if (scoped.status === 'revoked' || scoped.status === 'completed') {
    return errorResponse(`Cannot generate a link for an invitation in status "${scoped.status}"`, {
      code: 'INVITATION_NOT_LINKABLE',
      status: 409,
    });
  }

  // Rotate the token so the returned URL works; the previous link is invalidated.
  const { token, tokenHash, expiresAt } = mintInvitationToken();
  await prisma.appQuestionnaireInvitation.update({
    where: { id: invitationId },
    data: { tokenHash, expiresAt },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_invitation.link',
    entityType: 'questionnaire_invitation',
    entityId: invitationId,
    metadata: { questionnaireId: id },
    clientIp,
  });
  log.info('Invitation copy-link generated', { questionnaireId: id, invitationId });

  return successResponse({
    url: buildFrictionlessInviteUrl(scoped.versionId, token),
    expiresAt: expiresAt.toISOString(),
  });
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<Params> }
): Promise<Response> {
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handleLink(request, context);
}
