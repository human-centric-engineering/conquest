/**
 * Session lifecycle/status — respondent read (F7.3).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/status
 *   → { success: true, data: SessionStatusView }
 *
 * The signal the SSE stream doesn't carry: whether the agent may now offer submission,
 * the cost-cap tier, and whether the session is anonymous. The respondent UI refetches
 * this whenever a turn settles (the same `onTurnSettled` that drives the F7.2 answer
 * panel), so a Submit affordance appears at the moment the questionnaire is ready —
 * without reopening the streaming contract.
 *
 * Gate order mirrors the answers route: live-sessions flag (404 before auth) → load →
 * access (an authenticated owner OR a valid anonymous `X-Session-Token`) → respond. No
 * status gate — a paused or completed session still reports its status (that's how the
 * UI knows to show "resume" vs. the completion screen). No extra rate limiter: a read
 * inherits the automatic 100/min on `/api/v1/**`.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { loadSessionStatus } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-status';

async function handleGetStatus(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const loaded = await loadSessionStatus(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    log.info('Session status read', {
      sessionId,
      status: loaded.view.status,
      completion: loaded.view.completion.kind,
    });

    return successResponse(loaded.view);
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = withLiveSessionsEnabled(handleGetStatus);
