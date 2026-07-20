/**
 * Experience-step Report publish / unpublish (report kind `cohort`, experience_step scope — F15.4).
 *
 * POST   …/report/publish   body: { revisionNumber? }  → pin a revision published
 * DELETE …/report/publish   body: {}                   → revert to draft
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
} from '@/lib/app/questionnaire/cohort-report';
import { loadStepReportScope } from '@/app/api/v1/app/experiences/_lib/step-report';

type Params = { id: string; stepId: string };

const publishSchema = z.object({
  revisionNumber: z.number().int().positive().optional(),
});
const unpublishSchema = z.object({});

async function loadReport(stepId: string) {
  return prisma.appCohortReport.findUnique({
    where: { experienceStepOwnerId: stepId },
    select: {
      id: true,
      revisions: {
        orderBy: { revisionNumber: 'desc' },
        take: 1,
        select: { revisionNumber: true },
      },
    },
  });
}

const handlePublish = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  const report = await loadReport(stepId);
  if (!report) {
    return errorResponse('No step report to publish', { code: 'NO_REPORT', status: 409 });
  }

  const body = await validateRequestBody(request, publishSchema);
  const head = report.revisions[0]?.revisionNumber;
  const revisionNumber = body.revisionNumber ?? head;
  if (!revisionNumber) {
    return errorResponse('No revision to publish', { code: 'NO_REVISION', status: 409 });
  }

  const ok = await setCohortReportPublish({ reportId: report.id, revisionNumber });
  if (!ok) {
    return errorResponse('Revision not found', { code: 'NO_REVISION', status: 404 });
  }
  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_report.publish',
    entityType: 'app_cohort_report',
    entityId: report.id,
    entityName: resolved.entityName,
    metadata: { scopeKind: 'experience_step', experienceId: id, stepId, revisionNumber },
    clientIp,
  });
  log.info('Step report published', { experienceId: id, stepId, revisionNumber });
  return successResponse(await buildCohortReportView({ scope: resolved.scope }));
});

const handleUnpublish = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIp = getClientIP(request);
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  const report = await loadReport(stepId);
  if (!report) {
    return errorResponse('No step report', { code: 'NO_REPORT', status: 409 });
  }

  await validateRequestBody(request, unpublishSchema);
  await setCohortReportPublish({ reportId: report.id, revisionNumber: null });
  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_report.unpublish',
    entityType: 'app_cohort_report',
    entityId: report.id,
    entityName: resolved.entityName,
    metadata: { scopeKind: 'experience_step', experienceId: id, stepId },
    clientIp,
  });
  return successResponse(await buildCohortReportView({ scope: resolved.scope }));
});

export const POST = handlePublish;
export const DELETE = handleUnpublish;
