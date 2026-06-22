/**
 * Cohort Report — generation (report kind `cohort`, F14.3).
 *
 * POST /api/v1/app/rounds/:id/cohort-report/generate   body: { versionId }
 *   Admin-only. Builds the round's dataset, runs the seeded cohort-report agent over it, and appends
 *   a new AI revision (the working head) — then returns the refreshed read view. Paid LLM work, so it
 *   carries a per-admin generate sub-cap on top of the section limiter. Gated by the cohort-report
 *   flag AND the per-version `config.cohortReport.enabled` toggle.
 *
 * Pipeline: cohort-report flag-gate (404) → withAdminAuth → 404 unknown round → 422 version not
 *   bundled → 403 when the version's cohort-report config is disabled → rate-limit → generate +
 *   persist revision → audit → return view (failed report row + 502 on generation error).
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { z } from 'zod';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  narrowCohortReportSettings,
  buildCohortDataset,
  buildCohortReportView,
  ensureCohortReport,
  appendCohortReportRevision,
  generateCohortReport,
} from '@/lib/app/questionnaire/cohort-report';
import { assertRoundBundlesVersion } from '@/app/api/v1/app/rounds/_lib/context';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string };

const bodySchema = z.object({ versionId: z.string().min(1).max(64) });

const handleGenerate = withAdminAuth<Params>(async (request, session, { params }) => {
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

  // Per-version opt-in gate (the second gate the cohort-report flag ANDs).
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

  // Per-admin generate sub-cap (paid LLM work).
  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Cohort-report generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  // Build the dataset once; reuse for generation + the returned view.
  const dataset = await buildCohortDataset({ roundId, roundName: round.name, versionId });
  const reportId = await ensureCohortReport({
    roundId,
    versionId,
    title: `${round.name} — cohort report`,
    userId: adminId,
  });

  let revisionNumber: number;
  try {
    const { content, costUsd } = await generateCohortReport({
      roundId,
      roundName: round.name,
      versionId,
      dataset,
    });
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
      entityName: round.name,
      metadata: { versionId, revisionNumber, costUsd },
      clientIp,
    });
  } catch (err) {
    await prisma.appCohortReport
      .update({
        where: { id: reportId },
        data: { status: 'failed', error: String(err).slice(0, 1000) },
      })
      .catch(() => undefined);
    logger.error('Cohort report generation failed', {
      roundId,
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Cohort report generation failed', {
      code: 'GENERATION_FAILED',
      status: 502,
    });
  }

  const view = await buildCohortReportView({ roundId, roundName: round.name, versionId, dataset });
  log.info('Cohort report generated', { roundId, versionId, revisionNumber });
  return successResponse(view);
});

export const POST = withCohortReportEnabled(handleGenerate);
