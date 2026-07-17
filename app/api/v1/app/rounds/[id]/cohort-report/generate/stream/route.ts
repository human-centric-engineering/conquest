/**
 * Cohort Report — streamed generation (report kind `cohort`).
 *
 * POST /api/v1/app/rounds/:id/cohort-report/generate/stream   body: { versionId }
 *   Admin-only. Identical guards/work to the synchronous generate route, but streams the build over
 *   SSE: a phase event per stage ("dataset_built", "synthesizing", …) then a terminal `done` (a new
 *   AI revision was appended + the report marked `ready`) or `error`. The admin watches the report
 *   build instead of waiting on a 90s spinner. Paid LLM work → per-admin generate sub-cap.
 *
 * Pre-stream guards return ordinary JSON errors (404 / 422 / 403 / 429); once those pass the response
 * switches to `text/event-stream` and all further outcomes are SSE events.
 */

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { sseResponse } from '@/lib/api/sse';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import {
  narrowCohortReportSettings,
  buildCohortDataset,
  ensureCohortReport,
  streamReportRun,
  roundScope,
} from '@/lib/app/questionnaire/cohort-report';
import { assertRoundBundlesVersion } from '@/app/api/v1/app/rounds/_lib/context';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string };

const bodySchema = z.object({ versionId: z.string().min(1).max(64) });

const handleGenerateStream = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id: roundId } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const { versionId } = await validateRequestBody(request, bodySchema);
  if (!(await assertRoundBundlesVersion(roundId, versionId))) {
    return errorResponse('Version is not bundled by this round', {
      code: 'VERSION_NOT_IN_ROUND',
      status: 422,
    });
  }

  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { cohortReport: true },
  });
  if (!narrowCohortReportSettings(config?.cohortReport).enabled) {
    return errorResponse('Cohort report is not enabled for this questionnaire version', {
      code: 'COHORT_REPORT_DISABLED',
      status: 403,
    });
  }

  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Cohort-report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scope = roundScope(roundId, versionId, round.name);
  const dataset = await buildCohortDataset(scope);
  const reportId = await ensureCohortReport({
    scope,
    title: `${round.name} — cohort report`,
    userId: adminId,
  });

  log.info('Cohort report streamed generation started', { roundId, versionId });
  return sseResponse(
    streamReportRun({ scope, dataset, reportId, adminId, entityName: round.name, clientIp }),
    { signal: request.signal }
  );
});

export const POST = handleGenerateStream;
