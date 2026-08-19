/**
 * One persisted Adaptive Scope evaluation run (F17.21).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/topics/evaluations/:runId
 *   Admin-only. Returns one run with its findings (ordered by dimension, then ordinal), scoped
 *   to the version — a run from another version 404s.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { getScopeEvaluationRunDetail } from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-run-routes';

const handleRunDetail = withAdminAuth<{ id: string; vid: string; runId: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, runId } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const detail = await getScopeEvaluationRunDetail(vid, runId);
    if (!detail) {
      throw new NotFoundError('Scope evaluation run not found');
    }

    log.info('Adaptive Scope evaluation run read', {
      versionId: vid,
      runId,
      findingCount: detail.findings.length,
    });

    return successResponse(detail);
  }
);

export const GET = handleRunDetail;
