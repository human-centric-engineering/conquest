/**
 * Questionnaire detail endpoint (P2 / F2.1a).
 *
 * GET /api/v1/app/questionnaires/:id
 *   Admin-only read of one questionnaire plus a newest-first summary of each of
 *   its versions (status, goal/audience, section/question/change counts). 404 when
 *   the id is unknown — and, like every `/api/v1/app/**` route, 404 when the
 *   feature flag is off. Read model: `_lib/detail.ts`. Edit affordances arrive in
 *   F2.1b (PR2).
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getQuestionnaireDetail } from '@/app/api/v1/app/questionnaires/_lib/detail';

const handleDetail = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const detail = await getQuestionnaireDetail(id);
  if (!detail) {
    return errorResponse('Questionnaire not found', { code: 'NOT_FOUND', status: 404 });
  }

  log.info('Questionnaire detail read', {
    questionnaireId: id,
    versionCount: detail.versions.length,
  });
  return successResponse(detail);
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Flag gate first — a switched-off app is indistinguishable from a missing route.
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handleDetail(request, context);
}
