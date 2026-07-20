/**
 * Experience-step Report revision history (report kind `cohort`, experience_step scope — F15.4).
 *
 * GET  …/report/revisions                          → the revision history (newest first)
 * POST …/report/revisions  body: { revisionNumber }  → restore a past revision
 *   Admin-only. Restore appends the chosen revision's content as a new `admin` revision (history is
 *   never rewritten) and returns the refreshed view. Gated by the cohort-report flag.
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
  listCohortReportRevisions,
  restoreCohortReportRevision,
} from '@/lib/app/questionnaire/cohort-report';
import { loadStepReportScope } from '@/app/api/v1/app/experiences/_lib/step-report';

type Params = { id: string; stepId: string };

async function loadReportId(stepId: string): Promise<string | null> {
  const report = await prisma.appCohortReport.findUnique({
    where: { experienceStepOwnerId: stepId },
    select: { id: true },
  });
  return report?.id ?? null;
}

const handleGet = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id, stepId } = await params;
  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  const reportId = await loadReportId(stepId);
  const revisions = reportId ? await listCohortReportRevisions(reportId) : [];
  return successResponse({ revisions });
});

const restoreSchema = z.object({
  revisionNumber: z.number().int().positive(),
});

const handleRestore = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  const reportId = await loadReportId(stepId);
  if (!reportId) {
    return errorResponse('No step report to restore', { code: 'NO_REPORT', status: 409 });
  }
  const body = await validateRequestBody(request, restoreSchema);

  const newRevision = await restoreCohortReportRevision({
    reportId,
    sourceRevisionNumber: body.revisionNumber,
    userId: session.user.id,
  });
  if (newRevision === null) {
    return errorResponse('Revision not found', { code: 'NO_REVISION', status: 404 });
  }
  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_report.restore',
    entityType: 'app_cohort_report',
    entityId: reportId,
    entityName: resolved.entityName,
    metadata: {
      scopeKind: 'experience_step',
      experienceId: id,
      stepId,
      restored: body.revisionNumber,
      newRevision,
    },
    clientIp,
  });
  log.info('Step report revision restored', {
    experienceId: id,
    stepId,
    restored: body.revisionNumber,
    newRevision,
  });
  return successResponse(await buildCohortReportView({ scope: resolved.scope }));
});

export const GET = handleGet;
export const POST = handleRestore;
