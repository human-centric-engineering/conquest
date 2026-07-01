/**
 * Scheduled maintenance cron — serverless entry point.
 *
 * GET /api/v1/cron/maintenance
 *
 * Drives the shared maintenance tick on serverless (Vercel), where there is no persistent
 * process to run `instrumentation.ts`'s in-process ticker. Configure Vercel Cron (see
 * `vercel.json`) to call this every minute; Vercel auto-attaches `Authorization: Bearer
 * $CRON_SECRET` when the env var is set. On Hobby (daily-only cron), point an external cron
 * (GitHub Actions / cron-job.org) at this URL with the same bearer header.
 *
 * Auth is a direct `CRON_SECRET` bearer check — NOT `withAdminAuth` (that guard is session /
 * API-key based, which a cron can't satisfy). When `CRON_SECRET` is unset the endpoint refuses
 * every request, so an unconfigured deploy fails closed rather than exposing maintenance work.
 *
 * Unlike the admin tick route (which returns 202 and detaches the background chain), this runs
 * the chain in **awaited** mode so queued respondent reports / eval runs / retries actually
 * complete before the function is frozen. `maxDuration` is raised accordingly.
 *
 * @see .context/orchestration/scheduling.md
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';
import { runMaintenanceTick } from '@/lib/orchestration/maintenance/run-tick';

/** Await the full background chain — needs headroom for a batch of report/eval LLM calls. */
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<Response> {
  if (!env.CRON_SECRET) {
    logger.warn('Maintenance cron called but CRON_SECRET is not configured — refusing');
    return errorResponse('Cron endpoint is not configured', {
      code: 'CRON_NOT_CONFIGURED',
      status: 503,
    });
  }

  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return errorResponse('Unauthorized', { code: 'UNAUTHORIZED', status: 401 });
  }

  const result = await runMaintenanceTick({ awaitBackground: true });

  return successResponse({
    skipped: result.skipped,
    schedules: result.schedules,
    durationMs: Date.now() - result.startMs,
  });
}
