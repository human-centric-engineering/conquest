/**
 * Completion funnel (F8.1).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/analytics/funnel
 *   Admin-only. Computes the invited → opened → started → completed funnel for a
 *   version, with per-stage drop-off and a separate count of anonymous (un-invited)
 *   sessions. Query params: `from`/`to` (YYYY-MM-DD, default last 30 days).
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
  getCompletionFunnel,
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

    const result = await getCompletionFunnel(scope);
    log.info('Questionnaire analytics funnel computed', {
      versionId: vid,
      invited: result.stages[0]?.count ?? 0,
      completed: result.stages[result.stages.length - 1]?.count ?? 0,
    });

    return successResponse(result);
  }
);

export const GET = withQuestionnairesEnabled(handleGet);
