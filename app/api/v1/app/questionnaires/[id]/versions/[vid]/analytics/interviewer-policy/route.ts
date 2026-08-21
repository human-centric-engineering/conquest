/**
 * Interviewer policy — what the configured policy actually did (F18.7).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/analytics/interviewer-policy
 *   Admin-only. Aggregates the version's turns over the window: how far through the funnel arc
 *   sessions got, whether each `must_ask` question was ever reached, and how many house rules are
 *   in force — plus the observations those counts support.
 *
 *   Counts and question keys only — no respondent words, no session identities — and k-anon
 *   suppressed below the threshold. Query params: `from`/`to` (YYYY-MM-DD, default last 30 days),
 *   `roundId`. Read-only — version-scoped.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';

import {
  questionnaireAnalyticsQuerySchema,
  resolveAnalyticsScope,
  getInterviewerPolicyAnalytics,
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

    const result = await getInterviewerPolicyAnalytics(scope);
    log.info('Questionnaire analytics interviewer policy computed', {
      versionId: vid,
      sessions: result.sessions,
      findings: result.findings.length,
      suppressed: result.suppressed,
    });

    return successResponse(result);
  }
);

export const GET = handleGet;
