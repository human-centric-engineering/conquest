/**
 * One persisted design-time evaluation run (F5.2).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/evaluations/:runId
 *   Admin-only. Returns one run with its findings (ordered by dimension, then ordinal),
 *   scoped to the version — a run from another version 404s. Read-only: master-flag-gated
 *   and version-scoped via `loadScopedVersion`, no sub-flag 404 (persisted history stays
 *   readable, the same posture as the runs list and the `changes` review).
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { getEvaluationRunDetail } from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';

const handleRunDetail = withAdminAuth<{ id: string; vid: string; runId: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, runId } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const detail = await getEvaluationRunDetail(vid, runId);
    if (!detail) {
      throw new NotFoundError('Evaluation run not found');
    }

    log.info('Questionnaire design-evaluation run read', {
      versionId: vid,
      runId,
      findingCount: detail.findings.length,
    });

    return successResponse(detail);
  }
);

export const GET = handleRunDetail;
