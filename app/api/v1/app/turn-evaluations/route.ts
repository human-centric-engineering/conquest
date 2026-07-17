/**
 * Persisted turn-evaluation search surface — list.
 *
 * GET /api/v1/app/turn-evaluations
 *   Paginated, filterable, admin-only list of persisted turn evaluations across every preview
 *   session. Query params: page, limit, flagStatus, effectiveness, questionnaireVersionId,
 *   model, minScore, maxScore, from, to, sortBy (createdAt|overallScore), sortOrder. Each row is
 *   enriched with its questionnaire title + version number in a fixed query budget (no per-row
 *   N+1). Read-only; the read model lives in `_lib/turn-evaluation-list.ts`.
 *
 *   Admin only. Gated by the turn-evaluation flag (404 when off — the same gate as the route
 *   that produced the rows). Inherits the 100/min `api` section cap; no sub-cap (a read).
 */

import type { NextRequest } from 'next/server';

import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import {
  listTurnEvaluations,
  listTurnEvaluationsQuerySchema,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list';

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, listTurnEvaluationsQuerySchema);

  const { items, total } = await listTurnEvaluations(query);

  log.info('Turn evaluations listed', {
    total,
    page: query.page,
    flagStatus: query.flagStatus,
  });

  return paginatedResponse(items, { page: query.page, limit: query.limit, total });
});

export const GET = handleList;
