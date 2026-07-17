/**
 * Chat-transcript text — respondent download (F7.6).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/transcript.txt
 *   → text/plain (attachment)
 *
 * The plain-text twin of `transcript.pdf`: the same intro (questionnaire context + support
 * reference + run details) and the same labelled, timestamped turns, as a readable `.txt`.
 * Serves the same two respondent kinds, so it reuses `resolveTurnAccess` (authenticated
 * owner OR anonymous `X-Session-Token`).
 *
 * Gate order mirrors the PDF route: live-sessions flag (404 before auth) → load → access
 * (401/403) → build model → serialise → respond. No logo fetch (text has no branding) and
 * no `nodejs` runtime requirement (no PDF renderer), but the route is kept symmetric with
 * its PDF sibling.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import {
  loadTranscriptExport,
  assembleTranscriptExportModel,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';
import { buildTranscriptText } from '@/lib/app/questionnaire/export/build-transcript-text';
import { transcriptTextResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-response';

async function handleTranscriptText(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const loaded = await loadTranscriptExport(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const model = await assembleTranscriptExportModel(loaded, { fetchLogo: false });
    const text = buildTranscriptText(model);

    log.info('Transcript export text generated', {
      sessionId,
      anonymous: model.anonymous,
      turnCount: model.turns.length,
    });

    return transcriptTextResponse(text, model);
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = handleTranscriptText;
