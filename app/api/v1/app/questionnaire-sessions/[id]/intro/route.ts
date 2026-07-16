/**
 * Respondent intro / splash — runtime read (respondent surface).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/intro
 *   → { success: true, data: { intro: ResolvedSessionIntro | null } }
 *
 * The no-login anonymous surface boots client-side (its signed token never touches server HTML), so
 * unlike the authenticated page (which resolves the intro server-side) it fetches the resolved splash
 * here, on boot, before it decides whether to show the intro screen. Same two respondent kinds as the
 * turn/transcript routes, so it reuses `resolveTurnAccess` (an authenticated owner OR a valid
 * anonymous/preview `X-Session-Token`). Read-only. Returns `intro: null` when the platform flag is
 * off — the per-version `intro.enabled` (inside the payload) is the second gate the client honours.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { resolveSessionIntro } from '@/lib/app/questionnaire/intro/resolve';

async function handleGetIntro(
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

    const intro = await resolveSessionIntro(sessionId);
    log.info('Session intro read', { sessionId, enabled: intro?.enabled ?? false });
    return successResponse({ intro });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = handleGetIntro;
