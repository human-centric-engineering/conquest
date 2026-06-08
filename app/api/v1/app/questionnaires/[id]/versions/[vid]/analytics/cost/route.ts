/**
 * Per-version cost actuals (F8.1).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/analytics/cost
 *   Admin-only. Aggregates the version's `AiCostLog` spend over the window: total,
 *   runtime vs design-time split, per-capability breakdown, daily trend, and top
 *   sessions by spend. Query params: `from`/`to` (YYYY-MM-DD, default last 30 days).
 *   Read-only — master-flag-gated and version-scoped; no sub-flag.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  questionnaireAnalyticsQuerySchema,
  resolveAnalyticsScope,
  getQuestionnaireCostBreakdown,
} from '@/lib/app/questionnaire/analytics';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

const handleGet = withAdminAuth<{ id: string; vid: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const query = validateQueryParams(searchParams, questionnaireAnalyticsQuerySchema);
    const scope = resolveAnalyticsScope(vid, query);

    const result = await getQuestionnaireCostBreakdown(scope);
    log.info('Questionnaire analytics cost computed', {
      versionId: vid,
      totalCostUsd: result.totalCostUsd,
    });

    return successResponse(result);
  }
);

export const GET = withQuestionnairesEnabled(handleGet);
