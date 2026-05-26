/**
 * Unified Maintenance Tick — HTTP entry point.
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * Designed to be called every ~60s by an external cron job. Returns
 * 202 once `processDueSchedules()` has claimed and fired any due
 * schedules; the remaining seven tasks run as a background chain
 * inside the same overlap guard. See
 * `lib/orchestration/maintenance/run-tick.ts` for the task list and
 * the guard / watchdog mechanics — both this route and the dev-only
 * `instrumentation.ts` setInterval share that body.
 *
 * Auth: Admin role required (session or API key with admin scope).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import {
  BACKGROUND_TASK_NAMES,
  runMaintenanceTick,
  __test_setTickRunning as sharedTestSetTickRunning,
} from '@/lib/orchestration/maintenance/run-tick';

/** Exposed for testing only — simulate an in-progress tick. */
export const __test_setTickRunning = sharedTestSetTickRunning;

export const POST = withAdminAuth(async (_request) => {
  const result = await runMaintenanceTick();

  if (result.skipped) {
    return successResponse({ skipped: true, reason: 'previous tick still running' });
  }

  return successResponse(
    {
      schedules: result.schedules,
      backgroundTasks: BACKGROUND_TASK_NAMES,
      durationMs: Date.now() - result.startMs,
    },
    undefined,
    { status: 202 }
  );
});
