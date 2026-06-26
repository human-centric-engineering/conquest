/**
 * Version-wide Report — generation (report kind `cohort`, version scope).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/cohort-report/generate
 *   Admin-only. Builds the version-wide dataset (every round + open-ended session for the version),
 *   runs the seeded cohort-report agent over it, and appends a new AI revision (the working head) —
 *   then returns the refreshed read view. Paid LLM work, so it carries a per-admin generate sub-cap on
 *   top of the section limiter. Gated by the cohort-report flag AND the per-version
 *   `config.cohortReport.enabled` toggle.
 *
 * Pipeline: cohort-report flag-gate (404) → withAdminAuth → 404 unknown version → 403 when the
 *   version's cohort-report config is disabled → rate-limit → generate + persist revision → audit →
 *   return view (failed report row + 502 on generation error).
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

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  buildCohortDataset,
  buildCohortReportView,
  ensureCohortReport,
  appendCohortReportRevision,
  generateCohortReport,
} from '@/lib/app/questionnaire/cohort-report';
import {
  loadVersionReportScope,
  isVersionReportEnabledForVersion,
} from '@/app/api/v1/app/questionnaires/_lib/version-report';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string; vid: string };

const handleGenerate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id, vid } = await params;

  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  // Per-version opt-in gate (the second gate the cohort-report flag ANDs).
  if (!(await isVersionReportEnabledForVersion(vid))) {
    return errorResponse('Version-wide report is not enabled for this questionnaire version', {
      code: 'COHORT_REPORT_DISABLED',
      status: 403,
    });
  }

  // Per-admin generate sub-cap (paid LLM work).
  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Version-report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  // Build the dataset once; reuse for generation + the returned view.
  const scope = resolved.scope;
  const dataset = await buildCohortDataset(scope);
  const reportId = await ensureCohortReport({
    scope,
    title: `${resolved.entityName} — version-wide report`,
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
      metadata: { scopeKind: 'version', versionId: vid, revisionNumber, costUsd },
      clientIp,
    });
  } catch (err) {
    await prisma.appCohortReport
      .update({
        where: { id: reportId },
        data: { status: 'failed', error: String(err).slice(0, 1000) },
      })
      .catch(() => undefined);
    logger.error('Version report generation failed', {
      questionnaireId: id,
      versionId: vid,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Version report generation failed', {
      code: 'GENERATION_FAILED',
      status: 502,
    });
  }

  const view = await buildCohortReportView({ scope, dataset });
  log.info('Version report generated', { questionnaireId: id, versionId: vid, revisionNumber });
  return successResponse(view);
});

export const POST = withCohortReportEnabled(handleGenerate);
