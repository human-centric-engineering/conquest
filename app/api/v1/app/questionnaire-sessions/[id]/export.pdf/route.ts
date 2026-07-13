/**
 * Session results PDF — respondent download (F7.4).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/export.pdf
 *   → application/pdf (attachment)
 *
 * The respondent's takeaway: a branded PDF of their session's answers, offered on the
 * F7.3 completion screen. Serves the same two respondent kinds as the rest of the
 * session surface, so it reuses `resolveTurnAccess` (an authenticated owner OR a valid
 * anonymous `X-Session-Token`) rather than `withAuth`.
 *
 * Gate order mirrors the answers/status routes: live-sessions flag (404 before auth) →
 * load → access (401/403) → build model (logo fetch happens only after auth) → render →
 * respond. Anonymous-mode redaction lives in the model builder — when the version is
 * `anonymousMode`, no identity reaches the PDF. No status gate: a paused or completed
 * session can both be exported (a completed one is the common case). No extra rate
 * limiter beyond the automatic 100/min on `/api/v1/**` — rendering is the only cost.
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
  loadSessionExport,
  buildSessionExportPdfModel,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';
import { renderSessionPdf } from '@/app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf';
import { sessionPdfResponse } from '@/app/api/v1/app/questionnaire-sessions/_lib/pdf-response';
import { buildRespondentReportClientView } from '@/lib/app/questionnaire/report/view';
import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';

export const runtime = 'nodejs';

async function handleExportPdf(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const loaded = await loadSessionExport(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Include the AI report in the PDF when ready (the on-screen and PDF artifacts should match).
    // Raw-only / not-yet-ready → null (answers only). The config's `rawIncludes` chooses which
    // questionnaire data accompanies the report — the Q&A listing and/or the captured data slots.
    const reportView = await buildRespondentReportClientView(sessionId);
    const ready = reportView?.insights?.status === 'ready' ? reportView.insights : null;
    const insights = ready ? ready.content : null;
    const narrative = reportView?.mode === 'narrative';
    const cfg = reportView?.includeData ?? { questions: true, dataSlots: false };
    // Honour the config, EXCEPT when an AI report was expected but isn't embedded yet (still
    // generating): fall back to the full answers so the download is never an empty document. Raw
    // mode (no AI report) and a ready AI report both honour `rawIncludes` exactly.
    const aiPending = reportView != null && isAiRespondentReportMode(reportView.mode) && !insights;
    const includeQuestions = aiPending ? true : cfg.questions;

    const model = await buildSessionExportPdfModel(loaded, {
      insights,
      narrative,
      includeQuestions,
      includeDataSlots: cfg.dataSlots,
      // Trust the formatter's layout in the PDF too, so it matches the on-screen render.
      formatted: ready?.formatted ?? false,
      completionPct: ready?.completionPct ?? null,
    });
    const pdf = await renderSessionPdf(model);

    log.info('Session export PDF generated', {
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

export const GET = withLiveSessionsEnabled(handleExportPdf);
