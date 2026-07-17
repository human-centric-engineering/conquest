/**
 * Version-wide Report — read view (report kind `cohort`, version scope).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/cohort-report
 *   Admin-only. Returns the version-wide report read view: the report header (status, publish state,
 *   cost, revision count), the working-head revision's content, and the dataset the charts render
 *   against. `exists: false` when nothing has been generated yet. Read-only — no paid work; gated by
 *   the cohort-report flag.
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/cohort-report   body: { content }
 *   Admin-only. Appends the edited content as a new `admin` revision (the working head). Gated by the
 *   cohort-report flag.
 *
 * Pipeline: cohort-report flag-gate (404) → withAdminAuth → 404 unknown version → build view / edit.
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
  appendCohortReportRevision,
  validateCohortReportContent,
  isUsableCohortReportContent,
} from '@/lib/app/questionnaire/cohort-report';
import { loadVersionReportScope } from '@/app/api/v1/app/questionnaires/_lib/version-report';

type Params = { id: string; vid: string };

const patchSchema = z.object({
  /** The full edited report content (sanitised by validateCohortReportContent). */
  content: z.unknown(),
});

const handleGet = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, vid } = await params;

  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  const view = await buildCohortReportView({ scope: resolved.scope });
  log.info('Version report view loaded', {
    questionnaireId: id,
    versionId: vid,
    exists: view.exists,
  });
  return successResponse(view);
});

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid } = await params;

  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  const body = await validateRequestBody(request, patchSchema);

  // The report header must already exist (you edit a generated report, not an empty one).
  const report = await prisma.appCohortReport.findUnique({
    where: { versionOwnerId: vid },
    select: { id: true },
  });
  if (!report) {
    return errorResponse('No version report to edit — generate one first', {
      code: 'NO_REPORT',
      status: 409,
    });
  }

  const content = validateCohortReportContent(body.content);
  if (!isUsableCohortReportContent(content)) {
    return errorResponse('The edited report has no content', {
      code: 'EMPTY_CONTENT',
      status: 422,
    });
  }

  const revisionNumber = await appendCohortReportRevision({
    reportId: report.id,
    content,
    authoredBy: 'admin',
    summary: 'Manual edit',
    userId: session.user.id,
  });
  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_report.edit',
    entityType: 'app_cohort_report',
    entityId: report.id,
    entityName: resolved.entityName,
    metadata: { scopeKind: 'version', versionId: vid, revisionNumber },
    clientIp,
  });

  const view = await buildCohortReportView({ scope: resolved.scope });
  log.info('Version report edited', { questionnaireId: id, versionId: vid, revisionNumber });
  return successResponse(view);
});

export const GET = handleGet;
export const PATCH = handlePatch;
