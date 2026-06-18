/**
 * Transcript replay — respondent read (F7.1 — resume).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/transcript
 *   → { success: true, data: { turns: QuestionnaireTurn[] } }
 *
 * The no-login anonymous surface boots client-side (its signed token never touches server HTML),
 * so it can't SSR-seed the replayed transcript the way the authenticated page does — it fetches
 * it here instead, on boot, to decide whether to replay a prior conversation or open fresh. Serves
 * the same two respondent kinds as the turn route, so it reuses `resolveTurnAccess` (an
 * authenticated owner OR a valid anonymous/preview `X-Session-Token`). Read-only: no status gate —
 * a paused / completed session can still show what was said.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import {
  loadTranscript,
  loadInspectorTurns,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';

async function handleGetTranscript(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // The access fields (`resolveTurnAccess` branches on `respondentUserId`) plus the Preview Turn
    // Inspector hydration gate: its persisted traces are returned only for a preview session with
    // the version toggle on — the same admin-only gate the live-emit frame uses.
    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        respondentUserId: true,
        isPreview: true,
        version: { select: { config: { select: { previewInspectorEnabled: true } } } },
      },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const turns = await loadTranscript(sessionId);

    // Preview Turn Inspector (admin-only): re-hydrate the drawer on resume from the persisted
    // per-turn traces. Gated to a preview session with the toggle on, so a real respondent never
    // receives them; omitted from the payload entirely when off (no empty-array leakage of intent).
    const inspectorOn =
      session.isPreview && (session.version?.config?.previewInspectorEnabled ?? false);
    const inspectorTurns = inspectorOn ? await loadInspectorTurns(sessionId) : [];

    log.info('Transcript read', {
      sessionId,
      turnCount: turns.length,
      ...(inspectorOn ? { inspectorTurnCount: inspectorTurns.length } : {}),
    });
    return successResponse({ turns, ...(inspectorOn ? { inspectorTurns } : {}) });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = withLiveSessionsEnabled(handleGetTranscript);
