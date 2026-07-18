/**
 * Admin "Generate report" — first-time generation for a session that has none (alpha tooling).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/report/generate
 *   Admin-only (alpha). Force-queues the delivered respondent report and kicks the worker, so an admin
 *   can produce a report before (or without) the respondent's own submit-time generation. Refuses (409)
 *   when the questionnaire has no AI report configured, a report already has content, or one is already
 *   generating. The session drawer surfaces this only when {@link resolveAdminReportAvailability} says a
 *   report can be generated.
 *
 *   Gate order mirrors the browser: alpha release stage (404 before auth) → withAdminAuth → generate.
 */

import { after } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { generateDeliveredRespondentReport } from '@/lib/app/questionnaire/report/enqueue';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';
import { withAlphaSessionToolsEnabled } from '@/app/api/v1/app/questionnaire-sessions/_lib/alpha-gate';
import { reportRerunLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const handleGenerate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const adminId = session.user.id;
  const { id: sessionId } = await params;

  // Paid flow (a full report generation) — per-admin sub-cap on top of the section limit, matching the
  // sibling re-run + evaluate-saved routes. Per-session clobbering is refused downstream, so the cap is
  // what bounds fan-out ACROSS sessions.
  const rl = reportRerunLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const queued = await generateDeliveredRespondentReport(sessionId);
  if (!queued) {
    return errorResponse(
      'A report can’t be generated for this session right now (already generated, in progress, or not enabled).',
      { code: 'REPORT_GENERATE_UNAVAILABLE', status: 409 }
    );
  }

  log.info('Admin generated respondent report', { adminId, sessionId });

  // Kick the worker after the response (serverless-safe) so it generates within seconds.
  after(async () => {
    try {
      await processQueuedRespondentReports();
    } catch (err) {
      log.error('Report generate kick failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return successResponse({ queued: true }, undefined, { status: 202 });
});

export const POST = withAlphaSessionToolsEnabled(handleGenerate);
