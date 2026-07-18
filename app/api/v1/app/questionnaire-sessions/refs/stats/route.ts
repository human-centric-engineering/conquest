/**
 * Alpha session-ref browser — stats.
 *
 * GET /api/v1/app/questionnaire-sessions/refs/stats
 *   Admin-only. KPI totals + charts data (over-time trend, status breakdown, completion distribution,
 *   per-client and per-questionnaire counts) computed over the SAME filter set as the list, so the
 *   browser's stats strip always tracks the active filters. Accepts the full list query (page/limit/sort
 *   are ignored here).
 *
 *   Gate order mirrors the list: master flag → live-sessions flag → alpha release stage (404 before
 *   auth) → withAdminAuth → read. Inherits the 100/min `api` section cap; no sub-cap (a read).
 */

import type { NextRequest } from 'next/server';

import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { adminSessionListQuerySchema } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import { loadAdminSessionStats } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-stats';
import { withAlphaSessionToolsEnabled } from '@/app/api/v1/app/questionnaire-sessions/_lib/alpha-gate';

const handleStats = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, adminSessionListQuerySchema);

  const stats = await loadAdminSessionStats(query);

  log.info('Alpha session stats computed', { total: stats.total });

  return successResponse(stats);
});

export const GET = withAlphaSessionToolsEnabled(handleStats);
