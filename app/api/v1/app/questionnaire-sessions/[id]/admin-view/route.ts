/**
 * Admin session drawer read model (alpha tooling).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/admin-view
 *   Admin-only (alpha). Everything the Sessions drawer needs in ONE call: the replayed transcript
 *   (read-only), the currently delivered report, and the re-run panel seed (`settings`, `hasClient`,
 *   `initialView`) that {@link SessionReportRerun} mounts with. The full-page viewer assembles the same
 *   data server-side (`loadTranscript` + `loadAdminReportRerunPanel`); the drawer fetches it over HTTP.
 *
 *   The respondent transcript/report routes gate on `resolveTurnAccess` (a respondent credential the
 *   admin doesn't hold), so this admin-authed endpoint reads the models directly instead — the same
 *   trust boundary the viewer page relies on.
 *
 *   Gate order mirrors the browser: alpha release stage (404 before auth) → withAdminAuth → read. The
 *   alpha stage is the ONLY gate on this surface — there is no separate feature flag, so do not assume
 *   a flag can close it. Inherits the 100/min `api` section cap; no sub-cap (a read).
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';

import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';
import { loadAdminReportRerunPanel } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-report-rerun-view';
import { withAlphaSessionToolsEnabled } from '@/app/api/v1/app/questionnaire-sessions/_lib/alpha-gate';
import {
  buildAdminReportMethodView,
  buildRespondentReportClientView,
} from '@/lib/app/questionnaire/report/view';
import { resolveAdminReportAvailability } from '@/lib/app/questionnaire/report/availability';
import { SESSION_STATUSES, narrowToEnum } from '@/lib/app/questionnaire/types';

const handleAdminView = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: sessionId } = await params;

  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      versionId: true,
      status: true,
      _count: { select: { answers: true } },
      version: { select: { config: { select: { allowEarlyFinish: true } } } },
    },
  });
  if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

  const [turns, reportPanel, report, method, evaluationRows] = await Promise.all([
    loadTranscript(sessionId),
    loadAdminReportRerunPanel(session.versionId, sessionId),
    buildRespondentReportClientView(sessionId),
    // The admin projection of the method record — richer than the respondent's, and deliberately not
    // gated on `delivery.explainMethod` (see `buildAdminReportMethodView`).
    buildAdminReportMethodView(sessionId),
    // This session's persisted turn evaluations (lightweight) for the drawer's Evaluations tab.
    prisma.appQuestionnaireTurnEvaluation.findMany({
      where: { sessionId },
      orderBy: { turnOrdinal: 'asc' },
      select: {
        id: true,
        turnOrdinal: true,
        overallScore: true,
        effectiveness: true,
        flagStatus: true,
        comment: true,
        createdAt: true,
      },
    }),
  ]);

  const evaluations = evaluationRows.map((e) => ({
    id: e.id,
    turnOrdinal: e.turnOrdinal,
    overallScore: e.overallScore,
    effectiveness: e.effectiveness,
    flagStatus: e.flagStatus,
    commentPreview: e.comment ? e.comment.slice(0, 100) : null,
    createdAt: e.createdAt.toISOString(),
  }));

  // What the Report tab offers: a report exists (delivered content or a ready revision), can be
  // generated, or isn't available yet — gated on the questionnaire's early-report setting.
  const reportStatus = report?.insights?.status;
  const hasReport =
    report?.insights?.content != null ||
    reportPanel.initialView.revisions.some((r) => r.status === 'ready');
  const availability = resolveAdminReportAvailability({
    enabled: report?.enabled ?? false,
    hasReport,
    reportInFlight: reportStatus === 'queued' || reportStatus === 'processing',
    sessionStatus: narrowToEnum(session.status, SESSION_STATUSES, 'active'),
    answeredCount: session._count.answers,
    allowEarlyFinish: session.version?.config?.allowEarlyFinish ?? false,
  });

  log.info('Alpha session admin-view loaded', { sessionId, turnCount: turns.length });

  return successResponse({ turns, reportPanel, report, method, availability, evaluations });
});

export const GET = withAlphaSessionToolsEnabled(handleAdminView);
