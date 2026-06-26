/**
 * Resend a questionnaire invitation (F3.2).
 *
 * POST /api/v1/app/questionnaires/:id/invitations/:invitationId/resend
 *   Admin-only. Regenerates the token (invalidating the old link), refreshes the
 *   expiry, re-sends the email, and sets the invitation back to `sent`. Allowed only
 *   from pending | sent | opened (a registered/terminal/revoked invitation can't be
 *   resent). A send failure leaves the row at `pending` (the new token is still
 *   stored) and does not fail the request — the result carries the email status.
 *
 * Flag-gate first (404 when off), then `withAdminAuth`. `inviteLimiter` sub-cap +
 * audit, same as the create path.
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
import { isInvitationResendable } from '@/lib/app/questionnaire/invitations';
import { mintInvitationToken } from '@/lib/app/questionnaire/invitations/token';
import {
  loadScopedInvitation,
  toInvitationView,
  INVITATION_SELECT,
} from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/read';
import {
  resolveDemoClientTheme,
  sendInvitationEmail,
} from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/send';

type Params = { id: string; invitationId: string };

const handleResend = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, invitationId } = await params;

  const rateLimit = inviteLimiter.check(clientIp);
  if (!rateLimit.success) {
    log.warn('Invitation resend rate limit exceeded', { questionnaireId: id, invitationId });
    return createRateLimitResponse(rateLimit);
  }

  const scoped = await loadScopedInvitation(id, invitationId);
  if (!scoped) {
    return errorResponse('Invitation not found', { code: 'NOT_FOUND', status: 404 });
  }

  if (!isInvitationResendable(scoped.status)) {
    return errorResponse(`Cannot resend an invitation in status "${scoped.status}"`, {
      code: 'INVITATION_NOT_RESENDABLE',
      status: 409,
    });
  }

  // Send the NEW link first; only persist the regenerated token once it's actually
  // delivered. A failed send must NOT invalidate the recipient's existing working
  // link — we keep the old token and report the failure. Email derives the title from
  // the invitation's own pinned version (no launched-version lookup, no title drift).
  // DEMO-ONLY (F3.4): theme from the invitation's own brand snapshot — resends keep
  // the brand the respondent was originally invited under, even if the questionnaire
  // was later reattributed.
  const theme = await resolveDemoClientTheme(scoped.demoClientId);

  const { token, tokenHash, expiresAt } = mintInvitationToken();
  const emailResult = await sendInvitationEmail({
    to: scoped.email,
    inviteeName: scoped.name,
    questionnaireTitle: scoped.questionnaireTitle,
    token,
    expiresAt,
    theme,
  }).catch(() => ({ success: false, status: 'failed' as const, error: 'Email send threw' }));

  if (!emailResult.success) {
    log.warn('Invitation resend email failed; old link preserved', {
      questionnaireId: id,
      invitationId,
      emailStatus: emailResult.status,
    });
    return successResponse({
      invitation: toInvitationView(
        await prisma.appQuestionnaireInvitation.findUniqueOrThrow({
          where: { id: invitationId },
          select: INVITATION_SELECT,
        })
      ),
      emailStatus: emailResult.status,
    });
  }

  // Delivered — swap in the new token, refresh expiry, reset to `sent` (the respondent
  // must re-open the new link, so clear the prior open timestamp).
  const updated = await prisma.appQuestionnaireInvitation.update({
    where: { id: invitationId },
    data: { tokenHash, expiresAt, status: 'sent', sentAt: new Date(), openedAt: null },
    select: INVITATION_SELECT,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_invitation.resend',
    entityType: 'questionnaire_invitation',
    entityId: invitationId,
    metadata: { questionnaireId: id, emailStatus: emailResult.status },
    clientIp,
  });
  log.info('Invitation resent', {
    questionnaireId: id,
    invitationId,
    emailStatus: emailResult.status,
  });

  return successResponse({
    invitation: toInvitationView(updated),
    emailStatus: emailResult.status,
  });
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<Params> }
): Promise<Response> {
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handleResend(request, context);
}
