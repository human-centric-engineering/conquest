/**
 * Respondent Report re-runs — admin history + enqueue (F10.x "re-run report").
 *
 * GET  /api/v1/app/questionnaire-sessions/:id/report/revisions
 *   Admin-only. The delivered-report header summary + every admin re-run revision (newest first) for
 *   the session, so the session viewer can render the re-run history and mark which revision is live.
 *
 * POST /api/v1/app/questionnaire-sessions/:id/report/revisions   { config?, instructions? }
 *   Admin-only. Queues a re-run of the session's respondent report. `config` is the (possibly edited)
 *   report settings — the "new instructions/settings" for this run; omitted → the session's current
 *   version config is used. `instructions` is a short free-text note shown in the history. Generation is
 *   ASYNC: this only appends a `queued` revision that the maintenance worker then drives. Only the AI
 *   report modes (`raw_plus_insights`, `narrative`) generate a report; a `raw` config is rejected.
 *
 *   Gate order: master flag → respondent-report flag (404 before auth) → withAdminAuth → per-admin
 *   re-run sub-cap → validate → resolve settings → enqueue.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';

import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import {
  enqueueRespondentReportRevision,
  getRespondentReportRevisionsView,
} from '@/lib/app/questionnaire/report/revision';
import { reportRerunLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/** Body: the edited report settings (optional — defaults to the version config) + a short note. */
const rerunRequestSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  instructions: z.string().max(2000).optional(),
});

const handleList = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id: sessionId } = await params;

  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

  const view = await getRespondentReportRevisionsView(sessionId);
  return successResponse(view);
});

const handleEnqueue = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const adminId = session.user.id;
  const { id: sessionId } = await params;

  const rl = reportRerunLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Report re-run rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const body = await validateRequestBody(request, rerunRequestSchema);

  // The session must exist; grab its version config so an omitted `config` falls back to it.
  const found = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { id: true, version: { select: { config: { select: { respondentReport: true } } } } },
  });
  if (!found) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

  const settings = narrowRespondentReportSettings(
    body.config ?? found.version?.config?.respondentReport
  );

  // A re-run only produces a report in the AI modes; raw mode has nothing to generate.
  if (!isAiRespondentReportMode(settings.mode)) {
    return errorResponse('Re-running a report is only available for the AI report modes.', {
      code: 'REPORT_RERUN_MODE_UNSUPPORTED',
      status: 400,
    });
  }

  const { revisionNumber, revisionId } = await enqueueRespondentReportRevision({
    sessionId,
    settings,
    instructions: body.instructions ?? null,
    adminId,
  });

  log.info('Report re-run queued', { adminId, sessionId, revisionNumber, mode: settings.mode });
  return successResponse({ revisionNumber, revisionId, status: 'queued' as const }, undefined, {
    status: 202,
  });
});

export const GET = handleList;
export const POST = handleEnqueue;
