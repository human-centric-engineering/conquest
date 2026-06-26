/**
 * Version-wide Report — streamed generation (report kind `cohort`, version scope).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/cohort-report/generate/stream
 *   Admin-only. Identical guards/work to the synchronous generate route, but streams the build over
 *   SSE: a phase event per stage ("dataset_built", "synthesizing", …) then a terminal `done` (a new
 *   AI revision was appended + the report marked `ready`) or `error`. The admin watches the report
 *   build instead of waiting on a long spinner. Paid LLM work → per-admin generate sub-cap.
 *
 * Pre-stream guards return ordinary JSON errors (404 / 403 / 429); once those pass the response
 * switches to `text/event-stream` and all further outcomes are SSE events.
 */

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { sseResponse } from '@/lib/api/sse';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  buildCohortDataset,
  ensureCohortReport,
  streamReportRun,
} from '@/lib/app/questionnaire/cohort-report';
import {
  loadVersionReportScope,
  isVersionReportEnabledForVersion,
} from '@/app/api/v1/app/questionnaires/_lib/version-report';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string; vid: string };

const handleGenerateStream = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id, vid } = await params;

  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  if (!(await isVersionReportEnabledForVersion(vid))) {
    return errorResponse('Version-wide report is not enabled for this questionnaire version', {
      code: 'COHORT_REPORT_DISABLED',
      status: 403,
    });
  }

  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Version-report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scope = resolved.scope;
  const dataset = await buildCohortDataset(scope);
  const reportId = await ensureCohortReport({
    scope,
    title: `${resolved.entityName} — version-wide report`,
    userId: adminId,
  });

  log.info('Version report streamed generation started', { questionnaireId: id, versionId: vid });
  return sseResponse(
    streamReportRun({
      scope,
      dataset,
      reportId,
      adminId,
      entityName: resolved.entityName,
      clientIp,
    }),
    { signal: request.signal }
  );
});

export const POST = withCohortReportEnabled(handleGenerateStream);
