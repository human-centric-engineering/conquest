/**
 * Session results PDF — admin download (F7.4).
 *
 * GET /api/v1/app/questionnaires/:id/sessions/:sessionId/export.pdf
 *   → application/pdf (attachment)
 *
 * The admin-side export of any respondent's session, nested under the questionnaire so
 * the route enforces ownership: the session's version must belong to questionnaire `:id`
 * (404 otherwise — don't confirm a session exists under a questionnaire it doesn't).
 * Admin-authenticated (`withAdminAuth`); the feature-flag gate runs first
 * (`withQuestionnairesEnabled`) so a disabled app looks like a missing route.
 *
 * No admin UI triggers this yet — the P8 admin session views will wire a button to it.
 * Built now (per F7.4) so that work is pure front-end. Anonymous-mode redaction is the
 * same as the respondent route (applied in the model builder): an `anonymousMode`
 * version's PDF carries no respondent identity.
 *
 * `runtime = 'nodejs'`: `@react-pdf/renderer` renders to a Node Buffer.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  loadSessionExport,
  buildSessionExportPdfModel,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';
import { renderSessionPdf } from '@/app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf';
import { sessionPdfResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/pdf-response';
import { buildRespondentReportClientView } from '@/lib/app/questionnaire/report/view';

export const runtime = 'nodejs';

const handleAdminExportPdf = withAdminAuth<{ id: string; sessionId: string }>(
  async (request, _session, { params }) => {
    try {
      const log = await getRouteLogger(request);
      const { id: questionnaireId, sessionId } = await params;

      const loaded = await loadSessionExport(sessionId);
      // 404 when the session is unknown OR belongs to a different questionnaire — one
      // response either way, so the route never confirms a cross-questionnaire session.
      if (!loaded || loaded.questionnaireId !== questionnaireId) {
        return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });
      }

      // Embed the AI report (mode 2 or narrative) when ready, so the admin's PDF reflects what the
      // respondent received. Unlike the respondent route, the admin PDF keeps the full audit (raw
      // answers) alongside the report — it never sets `narrativeOnly`.
      const reportView = await buildRespondentReportClientView(sessionId);
      const ready = reportView?.insights?.status === 'ready' ? reportView.insights : null;
      const insights = ready ? ready.content : null;

      // Trust the formatter's layout here too, so the admin PDF matches the respondent's exactly (the
      // admin never sets narrativeOnly, so the report layout + caveat are the only things to keep in sync).
      const model = await buildSessionExportPdfModel(loaded, {
        insights,
        formatted: ready?.formatted ?? false,
        completionPct: ready?.completionPct ?? null,
      });
      const pdf = await renderSessionPdf(model);

      log.info('Admin session export PDF generated', {
        questionnaireId,
        sessionId,
        anonymous: model.anonymous,
        answeredCount: model.answeredCount,
        totalCount: model.totalCount,
      });

      return sessionPdfResponse(pdf, model);
    } catch (err) {
      return handleAPIError(err);
    }
  }
);

export const GET = withQuestionnairesEnabled(handleAdminExportPdf);
