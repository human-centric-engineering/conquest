/**
 * Safeguarding summary (sensitivity awareness).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/analytics/safeguarding
 *   Admin-only. Counts non-preview sessions in the window that flagged a sensitive disclosure
 *   (and how many were serious). Counts only — no summaries, no session identities — and k-anon
 *   suppressed below the threshold. Query params: `from`/`to` (YYYY-MM-DD, default last 30 days).
 *   Read-only — version-scoped (the count is safe to show even when sensitivity awareness is
 *   off — it's simply zero).
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';

import {
  questionnaireAnalyticsQuerySchema,
  resolveAnalyticsScope,
  getSafeguardingSummary,
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

    const result = await getSafeguardingSummary(scope);
    log.info('Questionnaire analytics safeguarding computed', {
      versionId: vid,
      flagged: result.flagged,
      serious: result.serious,
      suppressed: result.suppressed,
    });

    return successResponse(result);
  }
);

export const GET = handleGet;
