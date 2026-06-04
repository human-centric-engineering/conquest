/**
 * Extraction-change list endpoint (F2.3).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/changes
 *   Admin-only: list a version's `AppQuestionnaireExtractionChange` rows
 *   (newest-first), optionally filtered by `status`, `changeType`, or
 *   `targetEntityType`. Each row is enriched with a dry-run revert verdict
 *   (`revertable` / `revertBlockedReason` / `revertSummary`) so the review UI can
 *   disable the revert action and explain why before the admin clicks. Read-only;
 *   the read model lives in `_lib/extraction-review-routes.ts`.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { listChangesQuerySchema } from '@/lib/app/questionnaire/extraction-review';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { listVersionChanges } from '@/app/api/v1/app/questionnaires/_lib/extraction-review-routes';

const handleList = withAdminAuth<{ id: string; vid: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const filters = validateQueryParams(searchParams, listChangesQuerySchema);

    const result = await listVersionChanges(vid, filters);
    log.info('Questionnaire extraction changes listed', {
      versionId: vid,
      count: result.changes.length,
    });

    return successResponse(result);
  }
);

export const GET = withQuestionnairesEnabled(handleList);
