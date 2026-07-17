/**
 * Admin session transcript — read seam for the admin session viewer.
 *
 * GET /api/v1/app/questionnaires/:id/sessions/:sessionId/transcript
 *   → { success: true, data: { turns, isPreview, status, publicRef, anonymous, respondentName,
 *       questionnaireTitle, versionNumber } }
 *
 * The admin-side read of any respondent's conversation, nested under the questionnaire so the route
 * enforces ownership the same way the session export PDF does: the session's version must belong to
 * questionnaire `:id` (404 otherwise — never confirm a session under a questionnaire it doesn't
 * belong to). Admin-authenticated (`withAdminAuth`).
 *
 * Distinct from the respondent `/questionnaire-sessions/:id/transcript` (token / owner gated via
 * `resolveTurnAccess`): this is the admin path, so its authz mirrors the admin export, not the
 * respondent surface. Read-only — no status gate; a paused / completed / abandoned session can still
 * be read. Identity is redacted in anonymous mode by {@link loadAdminSessionView}.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';
import { loadAdminSessionView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

const handleAdminTranscript = withAdminAuth<{ id: string; sessionId: string }>(
  async (request, _session, { params }) => {
    try {
      const log = await getRouteLogger(request);
      const { id: questionnaireId, sessionId } = await params;

      const view = await loadAdminSessionView(sessionId);
      // 404 when the session is unknown OR belongs to a different questionnaire — one response
      // either way, so the route never confirms a cross-questionnaire session.
      if (!view || view.questionnaireId !== questionnaireId) {
        return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });
      }

      const turns = await loadTranscript(sessionId);

      log.info('Admin session transcript read', {
        questionnaireId,
        sessionId,
        turnCount: turns.length,
        isPreview: view.isPreview,
      });

      return successResponse({
        turns,
        isPreview: view.isPreview,
        status: view.status,
        publicRef: view.publicRef,
        anonymous: view.anonymous,
        respondentName: view.respondentName,
        questionnaireTitle: view.questionnaireTitle,
        versionNumber: view.versionNumber,
      });
    } catch (err) {
      return handleAPIError(err);
    }
  }
);

export const GET = handleAdminTranscript;
