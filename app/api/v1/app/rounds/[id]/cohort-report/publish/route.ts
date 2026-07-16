/**
 * Cohort Report publish / unpublish (report kind `cohort`, F14.6).
 *
 * POST   …/cohort-report/publish   body: { versionId, revisionNumber? }  → pin a revision published
 * DELETE …/cohort-report/publish   body: { versionId }                   → revert to draft
 *   Admin-only. Publishing pins a revision (default the working head); unpublishing clears it.
 *   Returns the refreshed view. Gated by the cohort-report flag.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import {
  buildCohortReportView,
  setCohortReportPublish,
  roundScope,
} from '@/lib/app/questionnaire/cohort-report';

type Params = { id: string };

const publishSchema = z.object({
  versionId: z.string().min(1).max(64),
  revisionNumber: z.number().int().positive().optional(),
});
const unpublishSchema = z.object({ versionId: z.string().min(1).max(64) });

async function loadReport(roundId: string) {
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: {
      id: true,
      name: true,
      cohortReport: {
        select: {
          id: true,
          revisions: {
            orderBy: { revisionNumber: 'desc' },
            take: 1,
            select: { revisionNumber: true },
          },
        },
      },
    },
  });
  return round;
}

const handlePublish = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id: roundId } = await params;

  const round = await loadReport(roundId);
  if (!round) throw new NotFoundError('Round not found');
  if (!round.cohortReport) {
    return errorResponse('No cohort report to publish', { code: 'NO_REPORT', status: 409 });
  }

  const body = await validateRequestBody(request, publishSchema);
  const head = round.cohortReport.revisions[0]?.revisionNumber;
  const revisionNumber = body.revisionNumber ?? head;
  if (!revisionNumber) {
    return errorResponse('No revision to publish', { code: 'NO_REVISION', status: 409 });
  }

  const ok = await setCohortReportPublish({ reportId: round.cohortReport.id, revisionNumber });
  if (!ok) {
    return errorResponse('Revision not found', { code: 'NO_REVISION', status: 404 });
  }
  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_report.publish',
    entityType: 'app_cohort_report',
    entityId: round.cohortReport.id,
    entityName: round.name,
    metadata: { versionId: body.versionId, revisionNumber },
    clientIp,
  });
  log.info('Cohort report published', { roundId, revisionNumber });
  return successResponse(
    await buildCohortReportView({ scope: roundScope(roundId, body.versionId, round.name) })
  );
});

const handleUnpublish = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIp = getClientIP(request);
  const { id: roundId } = await params;

  const round = await loadReport(roundId);
  if (!round) throw new NotFoundError('Round not found');
  if (!round.cohortReport) {
    return errorResponse('No cohort report', { code: 'NO_REPORT', status: 409 });
  }

  const body = await validateRequestBody(request, unpublishSchema);
  await setCohortReportPublish({ reportId: round.cohortReport.id, revisionNumber: null });
  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_report.unpublish',
    entityType: 'app_cohort_report',
    entityId: round.cohortReport.id,
    entityName: round.name,
    clientIp,
  });
  return successResponse(
    await buildCohortReportView({ scope: roundScope(roundId, body.versionId, round.name) })
  );
});

export const POST = handlePublish;
export const DELETE = handleUnpublish;
