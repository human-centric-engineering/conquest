/**
 * Admin preview-session continue token — mints the signed token that lets an admin CONTINUE a
 * preview conversation from the session viewer.
 *
 * POST /api/v1/app/questionnaires/:id/sessions/:sessionId/preview-token
 *   → { success: true, data: { accessToken, expiresAt } }
 *
 * This is the ONLY path by which the admin viewer obtains a continue token, and it is
 * structurally impossible to obtain one for a real respondent session: the handler 409s unless the
 * session is a preview (`isPreview`) AND active. A real respondent session (`respondentUserId` set)
 * is never a preview, so it can never be continued by an admin — read-only is enforced here, and
 * independently by `resolveTurnAccess` on the turn route (403 to a non-owner).
 *
 * Nested under the questionnaire for the same ownership check as the transcript read (404 when the
 * session belongs to a different questionnaire). Admin-authenticated.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const handleMintPreviewToken = withAdminAuth<{ id: string; sessionId: string }>(
  async (request, _session, { params }) => {
    try {
      const log = await getRouteLogger(request);
      const { id: questionnaireId, sessionId } = await params;

      const session = await prisma.appQuestionnaireSession.findUnique({
        where: { id: sessionId },
        select: {
          isPreview: true,
          status: true,
          version: { select: { questionnaireId: true } },
        },
      });

      // 404 when unknown OR cross-questionnaire — one response either way (same as the read).
      if (!session || session.version.questionnaireId !== questionnaireId) {
        return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });
      }

      // The hard gate: only a preview session can be continued by an admin. A real respondent
      // session is never a preview, so this closes the continue path for it.
      if (!session.isPreview) {
        return errorResponse('This session cannot be continued', {
          code: 'SESSION_NOT_PREVIEW',
          status: 409,
        });
      }
      if (session.status !== 'active') {
        return errorResponse(`Session is ${session.status}, not active`, {
          code: 'SESSION_NOT_ACTIVE',
          status: 409,
        });
      }

      const { token, expiresAt } = mintSessionToken(sessionId);
      log.info('Admin preview continue token minted', { questionnaireId, sessionId });

      return successResponse({ accessToken: token, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      return handleAPIError(err);
    }
  }
);

export const POST = handleMintPreviewToken;
