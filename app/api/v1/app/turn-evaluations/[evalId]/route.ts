/**
 * Persisted turn-evaluation detail.
 *
 * GET /api/v1/app/turn-evaluations/:evalId
 *   Admin-only, turn-evaluation-flag-gated. Returns one evaluation in full: the verdict, the
 *   snapshotted input that was judged, the complete review/provenance state, and the
 *   questionnaire title + version number. 404 when the row doesn't exist. Read-only; the read
 *   model lives in `_lib/turn-evaluation-list.ts`.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { withTurnEvaluationEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getTurnEvaluationDetail } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list';

const handleDetail = withAdminAuth<{ evalId: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { evalId } = await params;

  const evaluation = await getTurnEvaluationDetail(evalId);
  if (!evaluation) {
    return errorResponse('Evaluation not found', { code: 'NOT_FOUND', status: 404 });
  }

  log.info('Turn evaluation detail read', { evaluationId: evalId });
  return successResponse({ evaluation });
});

export const GET = withTurnEvaluationEnabled(handleDetail);
