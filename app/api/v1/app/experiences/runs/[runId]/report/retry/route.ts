/**
 * Re-queue a run-level report (F15.4b deferred item).
 *
 * POST /api/v1/app/experiences/runs/:runId/report/retry
 *
 * Backs the "Check again" affordance when a run report failed or was never generated. Until this
 * existed, "Check again" on a run report only opened a fresh poll window — honest, but useless
 * against a genuinely failed row.
 *
 * Refuses to clobber a report that already has content or is actively generating, exactly as the
 * per-session `generateDeliveredRespondentReport` does: a respondent pressing a button twice must
 * not destroy the report they are waiting for.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { after } from 'next/server';

import { canReadRun } from '@/app/api/v1/app/experiences/_lib/run-access';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';
import { enqueueRunReport } from '@/lib/app/questionnaire/report/enqueue';

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { runId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const access = await canReadRun(request, runId);
  // No admin bypass, matching the run-report read: a report is a narrative about a specific person.
  if (!access.allowed || access.isAdmin) {
    return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
  }

  const existing = await prisma.appRespondentReport.findUnique({
    where: { runId },
    select: { id: true, status: true, content: true },
  });

  if (existing?.content != null) {
    return errorResponse('This report has already been generated', {
      code: 'ALREADY_GENERATED',
      status: 409,
    });
  }
  if (existing && (existing.status === 'processing' || existing.status === 'queued')) {
    // Already on its way — say so rather than resetting the row underneath the worker.
    return successResponse({ queued: false, reason: 'in_flight' });
  }

  if (existing) {
    await prisma.appRespondentReport.update({
      where: { id: existing.id },
      data: { status: 'queued', error: null, lockedBy: null, lockedAt: null },
    });
  } else if (!(await enqueueRunReport(runId))) {
    // No row and none wanted — the entry leg's questionnaire has reports switched off.
    return errorResponse('Reports are not enabled for this journey', {
      code: 'REPORT_DISABLED',
      status: 409,
    });
  }

  // Kick the worker after the response, exactly as the submit route does, so generation starts in
  // seconds rather than at the next cron minute.
  after(async () => {
    try {
      await processQueuedRespondentReports();
    } catch (err) {
      log.error('Run report retry kick failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  log.info('Run report re-queued', { runId });
  return successResponse({ queued: true });
}
