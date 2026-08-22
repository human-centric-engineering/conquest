/**
 * One persisted Interviewer-policy evaluation run (F18.8).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluations/:runId
 *   Admin-only. Returns one run with its findings (ordered by dimension, then ordinal), scoped
 *   to the version — a run from another version 404s.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { getPolicyEvaluationRunDetail } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-run-routes';

const handleRunDetail = withAdminAuth<{ id: string; vid: string; runId: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, runId } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const detail = await getPolicyEvaluationRunDetail(vid, runId);
    if (!detail) {
      throw new NotFoundError('Policy evaluation run not found');
    }

    log.info('Interviewer-policy evaluation run read', {
      versionId: vid,
      runId,
      findingCount: detail.findings.length,
    });

    return successResponse(detail);
  }
);

export const GET = handleRunDetail;
