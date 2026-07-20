/**
 * Experience-step Report — streamed generation (report kind `cohort`, experience_step scope — F15.4).
 *
 * POST /api/v1/app/experiences/:id/steps/:stepId/cohort-report/generate/stream
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

import {
  buildCohortDataset,
  ensureCohortReport,
  streamReportRun,
} from '@/lib/app/questionnaire/cohort-report';
import {
  loadStepReportScope,
  isStepReportEnabledForVersion,
} from '@/app/api/v1/app/experiences/_lib/step-report';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string; stepId: string };

const handleGenerateStream = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  if (!(await isStepReportEnabledForVersion(resolved.versionId))) {
    return errorResponse('Reporting is not enabled for this step’s questionnaire version', {
      code: 'COHORT_REPORT_DISABLED',
      status: 403,
    });
  }

  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Step report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scope = resolved.scope;
  const dataset = await buildCohortDataset(scope);
  const reportId = await ensureCohortReport({
    scope,
    title: `${resolved.entityName} — step report`,
    userId: adminId,
  });

  log.info('Step report streamed generation started', { experienceId: id, stepId });
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

export const POST = handleGenerateStream;
