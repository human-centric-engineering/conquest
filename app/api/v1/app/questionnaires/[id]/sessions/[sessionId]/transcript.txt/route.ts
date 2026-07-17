/**
 * Chat-transcript text — admin download (P8 admin session views).
 *
 * GET /api/v1/app/questionnaires/:id/sessions/:sessionId/transcript.txt
 *   → text/plain (attachment)
 *
 * The plain-text twin of the admin `transcript.pdf`: the same intro + labelled, timestamped
 * turns as a readable `.txt`. Nested under the questionnaire so the route enforces ownership
 * (the session's version must belong to questionnaire `:id`; 404 otherwise). Admin-authenticated
 * (`withAdminAuth`).
 *
 * Mirrors the respondent text export (F7.6) but with admin auth instead of `resolveTurnAccess`.
 * Anonymous-mode redaction lives in the model builder. No logo fetch (text has no branding) and
 * no `nodejs` runtime requirement (no PDF renderer).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import {
  loadTranscriptExport,
  assembleTranscriptExportModel,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';
import { buildTranscriptText } from '@/lib/app/questionnaire/export/build-transcript-text';
import { transcriptTextResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-response';

const handleAdminTranscriptText = withAdminAuth<{ id: string; sessionId: string }>(
  async (request, _session, { params }) => {
    try {
      const log = await getRouteLogger(request);
      const { id: questionnaireId, sessionId } = await params;

      const loaded = await loadTranscriptExport(sessionId);
      // 404 when the session is unknown OR belongs to a different questionnaire — one response
      // either way, so the route never confirms a cross-questionnaire session.
      if (!loaded || loaded.questionnaireId !== questionnaireId) {
        return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });
      }

      const model = await assembleTranscriptExportModel(loaded, { fetchLogo: false });
      const text = buildTranscriptText(model);

      log.info('Admin transcript export text generated', {
        questionnaireId,
        sessionId,
        anonymous: model.anonymous,
        turnCount: model.turns.length,
      });

      return transcriptTextResponse(text, model);
    } catch (err) {
      return handleAPIError(err);
    }
  }
);

export const GET = handleAdminTranscriptText;
