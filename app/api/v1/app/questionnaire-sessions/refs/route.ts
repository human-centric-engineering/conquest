/**
 * Alpha session-ref browser — list.
 *
 * GET /api/v1/app/questionnaire-sessions/refs
 *   Admin-only. A paginated, cross-questionnaire list of every session that carries a support
 *   reference (newest first), so the alpha admin surface can browse refs + dates + statuses, open a
 *   session, and regenerate its report. Query params: page, limit, q (ref substring), status. Each row
 *   carries the questionnaire + version ids to deep-link the session viewer and analytics.
 *
 *   Gate order: master flag → live-sessions flag → alpha release stage (404 before auth) →
 *   withAdminAuth → read. This surface is deliberately protected once alpha ends (gated on
 *   `IS_ALPHA` / `NEXT_PUBLIC_RELEASE_STAGE`). Inherits the 100/min `api` section cap; no sub-cap (a read).
 */

import type { NextRequest } from 'next/server';

import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import {
  listAdminSessionRefs,
  adminSessionListQuerySchema,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import { withAlphaSessionToolsEnabled } from '@/app/api/v1/app/questionnaire-sessions/_lib/alpha-gate';

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, adminSessionListQuerySchema);

  const { items, total } = await listAdminSessionRefs(query);

  log.info('Alpha session refs listed', { total, page: query.page, hasSearch: Boolean(query.q) });

  return paginatedResponse(items, { page: query.page, limit: query.limit, total });
});

export const GET = withAlphaSessionToolsEnabled(handleList);
