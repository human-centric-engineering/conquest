/**
 * Respondent surface configuration — runtime read (respondent surface).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/surface
 *   → { success: true, data: { surface: RespondentSurfaceConfig } }
 *
 * The sibling of `/intro`, `/persona` and `/profile`, and the same reason all four exist: a
 * CLIENT-BOOTED respondent surface has no server render in which to resolve per-version config, so
 * it reads it here. Unlike those three this is not a feature's own state — it is the whole
 * affordance/brand/vocabulary bundle the workspace paints a session with (voice, presentation
 * mode, answer-panel scope, reasoning placement, inline correction, theme, glossary).
 *
 * The facilitated-meeting participant surface (P15.5) is the caller that forced it: it mounts once
 * and then swaps sessions in place as breakouts start, and each breakout — or each ROOM within a
 * breakout — may run a different questionnaire. Keyed on the session rather than the version so
 * one rule covers all three moments a session id arrives there (join, poll, room choice).
 *
 * Same two respondent kinds as the turn/transcript routes, so it reuses `resolveTurnAccess` (an
 * authenticated owner OR a valid anonymous/preview `X-Session-Token`). Read-only.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { resolveRespondentSurfaceConfig } from '@/lib/app/questionnaire/session/resolve-respondent-surface';

async function handleGetSurface(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const surface = await resolveRespondentSurfaceConfig(sessionId);
    // The existence check above passed, so a null here means the row vanished between the two
    // reads. Treated as a 404 rather than a 500: the session genuinely is not there any more.
    if (!surface) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    log.info('Session surface config read', {
      sessionId,
      presentationMode: surface.presentationMode,
      voice: surface.voiceInputEnabled,
    });
    return successResponse({ surface });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = handleGetSurface;
