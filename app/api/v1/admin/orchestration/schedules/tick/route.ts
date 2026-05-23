/**
 * Admin Orchestration — Scheduler Tick
 *
 * POST /api/v1/admin/orchestration/schedules/tick
 *
 * Processes all due workflow schedules. Designed to be called every
 * ~60 seconds by an external cron job (e.g. Vercel Cron, Railway Cron,
 * or a simple `curl` from system crontab).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { processDueSchedules } from '@/lib/orchestration/scheduling';

export const POST = withAdminAuth(async (_request) => {
  const result = await processDueSchedules();

  return successResponse({ ...result });
});
