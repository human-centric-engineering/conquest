/**
 * Cohort Report revision history (report kind `cohort`, F14.6).
 *
 * GET  …/cohort-report/revisions                          → the revision history (newest first)
 * POST …/cohort-report/revisions  body: { versionId, revisionNumber }  → restore a past revision
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
  roundScope,
} from '@/lib/app/questionnaire/cohort-report';

type Params = { id: string };

async function loadReportId(roundId: string): Promise<{ name: string; reportId: string | null }> {
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { name: true, cohortReport: { select: { id: true } } },
  });
  if (!round) throw new NotFoundError('Round not found');
  return { name: round.name, reportId: round.cohortReport?.id ?? null };
}

const handleGet = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id: roundId } = await params;
  const { reportId } = await loadReportId(roundId);
  const revisions = reportId ? await listCohortReportRevisions(reportId) : [];
  return successResponse({ revisions });
});

const restoreSchema = z.object({
  versionId: z.string().min(1).max(64),
  revisionNumber: z.number().int().positive(),
});

const handleRestore = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id: roundId } = await params;

  const { name, reportId } = await loadReportId(roundId);
  if (!reportId) {
    return errorResponse('No cohort report to restore', { code: 'NO_REPORT', status: 409 });
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
    entityName: name,
    metadata: { restored: body.revisionNumber, newRevision },
    clientIp,
  });
  log.info('Cohort report revision restored', {
    roundId,
    restored: body.revisionNumber,
    newRevision,
  });
  return successResponse(
    await buildCohortReportView({ scope: roundScope(roundId, body.versionId, name) })
  );
});

export const GET = handleGet;
export const POST = handleRestore;
