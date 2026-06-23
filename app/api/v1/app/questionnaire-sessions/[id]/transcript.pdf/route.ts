/**
 * Chat-transcript PDF — respondent download (F7.6).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/transcript.pdf
 *   → application/pdf (attachment)
 *
 * A branded PDF of the respondent's verbatim conversation — an intro explaining the
 * questionnaire context + the support reference, then every turn labelled
 * ("Interviewer" / the respondent) and timestamped. Sibling to the F7.4 answers export
 * (`export.pdf`); same two respondent kinds, so it reuses `resolveTurnAccess` (an
 * authenticated owner OR a valid anonymous `X-Session-Token`) rather than `withAuth`.
 *
 * Gate order mirrors the answers export: live-sessions flag (404 before auth) → load →
 * access (401/403) → build model (logo fetch happens only after auth) → render → respond.
 * Anonymous-mode redaction lives in the model builder — when the version is `anonymousMode`,
 * the respondent label stays the generic "Respondent". No status gate: a paused or completed
 * session can both be exported.
 *
 * `runtime = 'nodejs'`: `@react-pdf/renderer` renders to a Node Buffer.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import {
  loadTranscriptExport,
  assembleTranscriptExportModel,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';
import { renderTranscriptPdf } from '@/app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf';
import { transcriptPdfResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-response';

export const runtime = 'nodejs';

async function handleTranscriptPdf(
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

    const model = await assembleTranscriptExportModel(loaded, { fetchLogo: true });
    const pdf = await renderTranscriptPdf(model);

    log.info('Transcript export PDF generated', {
      sessionId,
      anonymous: model.anonymous,
      turnCount: model.turns.length,
    });

    return transcriptPdfResponse(pdf, model);
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = withLiveSessionsEnabled(handleTranscriptPdf);
