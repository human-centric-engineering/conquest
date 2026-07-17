/**
 * Admin session lookup by support reference — resolves a ref to its session's viewer location.
 *
 * GET /api/v1/app/questionnaires/sessions/by-ref/:ref
 *   → { success: true, data: SessionRefLocation }   (404 when no session matches)
 *
 * Powers the "View a session" ref input (the workspace header + the Sessions tab): the admin pastes
 * the support reference a respondent quoted, and this returns where to navigate — the questionnaire,
 * version, and session id of the viewer route. The resolved session may belong to a DIFFERENT
 * questionnaire than the one the admin is currently in, which is fine: the response carries the
 * session's own questionnaire/version so the UI sends the admin to wherever it actually lives.
 *
 * A static sibling of the `[id]` segment (like `…/questionnaires/prompts` and `…/compose`); Next
 * resolves the static `sessions` path ahead of the dynamic `[id]`. Admin-authenticated, flag-gated
 * first so a disabled app looks like a missing route. Lightweight — no turns or eval counts (unlike
 * the turn-evaluation `by-ref`); it only needs to point the admin at the viewer.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { resolveSessionRefLocation } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

const handleSessionByRef = withAdminAuth<{ ref: string }>(async (request, _session, { params }) => {
  try {
    const log = await getRouteLogger(request);
    const { ref } = await params;

    // Next.js already URL-decodes dynamic path segments; a second decodeURIComponent here would
    // throw URIError (→ 500) on a malformed `%` probe. `resolveSessionRefLocation` normalises.
    const location = await resolveSessionRefLocation(ref);
    if (!location) {
      return errorResponse('No session found for that reference', {
        code: 'NOT_FOUND',
        status: 404,
      });
    }

    log.info('Admin session ref resolved', {
      sessionId: location.sessionId,
      questionnaireId: location.questionnaireId,
    });
    return successResponse(location);
  } catch (err) {
    return handleAPIError(err);
  }
});

export const GET = handleSessionByRef;
