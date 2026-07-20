/**
 * Experience-step Report — read view (report kind `cohort`, experience_step scope — F15.4).
 *
 * GET /api/v1/app/experiences/:id/steps/:stepId/cohort-report
 *   Admin-only. Returns the step report read view: the header (status, publish state, cost,
 *   revision count), the working-head revision's content, and the dataset the charts render
 *   against. `exists: false` when nothing has been generated yet. Read-only — no paid work.
 *
 * PATCH … body: { content }
 *   Admin-only. Appends the edited content as a new `admin` revision (the working head).
 *
 * The scope analyses the legs of THIS step only. That is what keeps the whole pipeline reusable:
 * a step pins one questionnaire version, so the dataset's single-data-slot-vocabulary assumption
 * holds and no module below this route changed.
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
import { loadStepReportScope } from '@/app/api/v1/app/experiences/_lib/step-report';

type Params = { id: string; stepId: string };

const patchSchema = z.object({
  /** The full edited report content (sanitised by validateCohortReportContent). */
  content: z.unknown(),
});

const handleGet = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  // Null covers three ordinary states, all of which are "there is nothing to report on here":
  // the step belongs to another experience, it has no questionnaire attached yet, or its version
  // pointer no longer resolves (UG-1 pointers may dangle by design).
  if (!resolved) throw new NotFoundError('Experience step not found');

  const view = await buildCohortReportView({ scope: resolved.scope });
  log.info('Step report view loaded', { experienceId: id, stepId, exists: view.exists });
  return successResponse(view);
});

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  const body = await validateRequestBody(request, patchSchema);

  // The report header must already exist (you edit a generated report, not an empty one).
  const report = await prisma.appCohortReport.findUnique({
    where: { experienceStepOwnerId: stepId },
    select: { id: true },
  });
  if (!report) {
    return errorResponse('No step report to edit — generate one first', {
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
    metadata: { scopeKind: 'experience_step', experienceId: id, stepId, revisionNumber },
    clientIp,
  });

  const view = await buildCohortReportView({ scope: resolved.scope });
  log.info('Step report edited', { experienceId: id, stepId, revisionNumber });
  return successResponse(view);
});

export const GET = handleGet;
export const PATCH = handlePatch;
