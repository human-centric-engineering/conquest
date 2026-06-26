/**
 * Chat-transcript PDF — admin download (P8 admin session views).
 *
 * GET /api/v1/app/questionnaires/:id/sessions/:sessionId/transcript.pdf
 *   → application/pdf (attachment)
 *
 * The admin-side twin of the respondent transcript export (F7.6) — the same branded PDF of
 * the verbatim conversation, served from the admin session viewer. Nested under the
 * questionnaire so the route enforces ownership: the session's version must belong to
 * questionnaire `:id` (404 otherwise — don't confirm a session exists under a questionnaire
 * it doesn't). Admin-authenticated (`withAdminAuth`); the feature-flag gate runs first
 * (`withQuestionnairesEnabled`) so a disabled app looks like a missing route.
 *
 * Unlike the respondent route there is no `resolveTurnAccess` — admin auth replaces the
 * owner/anonymous-token check. Anonymous-mode redaction is unchanged: it lives in the model
 * builder, so an `anonymousMode` version's PDF carries no respondent identity. Sibling to the
 * admin answers export (`export.pdf`), and reuses the same transcript builders/renderer.
 *
 * `runtime = 'nodejs'`: `@react-pdf/renderer` renders to a Node Buffer.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  loadTranscriptExport,
  assembleTranscriptExportModel,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';
import { renderTranscriptPdf } from '@/app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf';
import { transcriptPdfResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-response';

export const runtime = 'nodejs';

const handleAdminTranscriptPdf = withAdminAuth<{ id: string; sessionId: string }>(
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

      const model = await assembleTranscriptExportModel(loaded, { fetchLogo: true });
      const pdf = await renderTranscriptPdf(model);

      log.info('Admin transcript export PDF generated', {
        questionnaireId,
        sessionId,
        anonymous: model.anonymous,
        turnCount: model.turns.length,
      });

      return transcriptPdfResponse(pdf, model);
    } catch (err) {
      return handleAPIError(err);
    }
  }
);

export const GET = withQuestionnairesEnabled(handleAdminTranscriptPdf);
