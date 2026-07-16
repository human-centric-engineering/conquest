/**
 * Version-wide Report revision history (report kind `cohort`, version scope).
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
import { loadVersionReportScope } from '@/app/api/v1/app/questionnaires/_lib/version-report';

type Params = { id: string; vid: string };

async function loadReportId(versionId: string): Promise<string | null> {
  const report = await prisma.appCohortReport.findUnique({
    where: { versionOwnerId: versionId },
    select: { id: true },
  });
  return report?.id ?? null;
}

const handleGet = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id, vid } = await params;
  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  const reportId = await loadReportId(vid);
  const revisions = reportId ? await listCohortReportRevisions(reportId) : [];
  return successResponse({ revisions });
});

const restoreSchema = z.object({
  revisionNumber: z.number().int().positive(),
});

const handleRestore = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid } = await params;

  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  const reportId = await loadReportId(vid);
  if (!reportId) {
    return errorResponse('No version report to restore', { code: 'NO_REPORT', status: 409 });
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
    metadata: { scopeKind: 'version', versionId: vid, restored: body.revisionNumber, newRevision },
    clientIp,
  });
  log.info('Version report revision restored', {
    questionnaireId: id,
    versionId: vid,
    restored: body.revisionNumber,
    newRevision,
  });
  return successResponse(await buildCohortReportView({ scope: resolved.scope }));
});

export const GET = handleGet;
export const POST = handleRestore;
