/**
 * Answer-slot panel state — respondent read (F7.2).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/answers
 *   → { success: true, data: AnswerPanelView }
 *
 * The data source for the live answer panel beside the chat. Serves the same two
 * respondent kinds as the turn route, so it reuses `resolveTurnAccess` (an
 * authenticated owner OR a valid anonymous `X-Session-Token`) rather than `withAuth`.
 *
 * Gate order mirrors the messages route: live-sessions flag (404 before auth) → load
 * the session → access (401/403) → respond. No status gate — a paused or completed
 * session still shows its answers (that's exactly when the panel is most useful). No
 * extra rate limiter: a read inherits the automatic 100/min on `/api/v1/**`.
 *
 * What the version's `answerSlotPanelScope` config returns is enforced in the read
 * seam's pure builder: `answered_only` omits pending slots, so the pending structure
 * never reaches the client.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { isDataSlotsEnabled, withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { loadAnswerPanelState } from '@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel';

async function handleGetAnswers(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // Data Slots feature: render the data-slot panel when the feature is on (the loader only
    // switches if the version actually has data slots). A cheap flag read before the access check.
    const loaded = await loadAnswerPanelState(sessionId, await isDataSlotsEnabled());
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    log.info('Answer panel read', {
      sessionId,
      answeredCount: loaded.view.answeredCount,
      totalCount: loaded.view.totalCount,
    });

    return successResponse(loaded.view);
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = withLiveSessionsEnabled(handleGetAnswers);
