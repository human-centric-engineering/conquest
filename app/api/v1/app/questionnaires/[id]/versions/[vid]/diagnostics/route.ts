/**
 * Per-invitation diagnostics — version rollup (Diagnostics).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/diagnostics
 *   Admin-only. Aggregate telemetry (tokens, response time, cost) + error tallies for the version
 *   over the window, plus one row per invitation. Query params: `from`/`to` (YYYY-MM-DD, default
 *   last 30 days), `roundId` (optional round scope). Read-only — master-flag-gated and
 *   version-scoped; no sub-flag (error capture is always-on, the tab is gated on liveSessions in UI).
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';

import {
  questionnaireAnalyticsQuerySchema,
  resolveAnalyticsScope,
  getVersionDiagnostics,
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

    const result = await getVersionDiagnostics(scope);
    log.info('Questionnaire diagnostics computed', {
      versionId: vid,
      invitations: result.invitations.length,
      errorCount: result.totals.errorCount,
    });

    return successResponse(result);
  }
);

export const GET = handleGet;
