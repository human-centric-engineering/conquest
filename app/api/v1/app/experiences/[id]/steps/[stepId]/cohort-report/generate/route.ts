/**
 * Experience-step Report — generation (report kind `cohort`, experience_step scope — F15.4).
 *
 * POST /api/v1/app/experiences/:id/steps/:stepId/cohort-report/generate
 *   Admin-only. Builds the dataset over the legs of THIS step, runs the seeded cohort-report agent
 *   over it, appends a new AI revision (the working head), and returns the refreshed read view.
 *   Paid LLM work, so it carries the same per-admin generate sub-cap the round and version routes
 *   use, on top of the section limiter.
 *
 * Reuses the entire cohort-report pipeline unchanged — the only new thing is the scope. Gated by
 * the step's version's own `config.cohortReport.enabled`: an author who turned reporting off for a
 * questionnaire has not consented to it being generated because that questionnaire was reached
 * through a journey.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import {
  buildCohortDataset,
  buildCohortReportView,
  ensureCohortReport,
  appendCohortReportRevision,
  generateCohortReport,
} from '@/lib/app/questionnaire/cohort-report';
import {
  loadStepReportScope,
  isStepReportEnabledForVersion,
} from '@/app/api/v1/app/experiences/_lib/step-report';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string; stepId: string };

const handleGenerate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  // Per-version opt-in gate — the same switch the round and version-wide reports AND. An author
  // who turned reporting off for a questionnaire has not consented to it being generated because
  // that questionnaire was reached through a journey.
  if (!(await isStepReportEnabledForVersion(resolved.versionId))) {
    return errorResponse('Reporting is not enabled for this step’s questionnaire version', {
      code: 'COHORT_REPORT_DISABLED',
      status: 403,
    });
  }

  // Per-admin generate sub-cap (paid LLM work). Shared with the other two scopes deliberately:
  // the cap exists to bound an admin's spend, and which scope they picked does not change that.
  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Step report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  // Build the dataset once; reuse for generation + the returned view.
  const scope = resolved.scope;
  const dataset = await buildCohortDataset(scope);
  const reportId = await ensureCohortReport({
    scope,
    title: `${resolved.entityName} — step report`,
    userId: adminId,
  });

  let revisionNumber: number;
  try {
    const { content, costUsd } = await generateCohortReport({ scope, dataset });
    revisionNumber = await appendCohortReportRevision({
      reportId,
      content,
      authoredBy: 'ai',
      summary: 'AI generation',
      costUsd,
      userId: adminId,
    });
    logAdminAction({
      userId: adminId,
      action: 'app_cohort_report.generate',
      entityType: 'app_cohort_report',
      entityId: reportId,
      entityName: resolved.entityName,
      metadata: {
        scopeKind: 'experience_step',
        experienceId: id,
        stepId,
        versionId: resolved.versionId,
        revisionNumber,
        costUsd,
      },
      clientIp,
    });
  } catch (err) {
    await prisma.appCohortReport
      .update({
        where: { id: reportId },
        data: { status: 'failed', error: String(err).slice(0, 1000) },
      })
      .catch(() => undefined);
    logger.error('Step report generation failed', {
      experienceId: id,
      stepId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Step report generation failed', {
      code: 'GENERATION_FAILED',
      status: 502,
    });
  }

  const view = await buildCohortReportView({ scope, dataset });
  log.info('Step report generated', { experienceId: id, stepId, revisionNumber });
  return successResponse(view);
});

export const POST = handleGenerate;
