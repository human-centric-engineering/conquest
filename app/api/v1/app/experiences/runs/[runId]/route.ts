/**
 * Experience run detail (P15.2) — admin.
 *
 * GET /api/v1/app/experiences/runs/:runId — the run with its legs, the routing decision and its
 * rationale, and what was carried at the handoff.
 *
 * `withAdminAuth`: this surface exists to answer "why did this respondent get that questionnaire",
 * which is an operator question. The respondent's own view is the poll endpoint.
 */

import { NotFoundError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAdminAuth } from '@/lib/auth/guards';

import { getRunDetail } from '@/app/api/v1/app/experiences/_lib/run-read';

const handleDetail = withAdminAuth<{ runId: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { runId } = await params;

  const run = await getRunDetail(runId);
  if (!run) {
    throw new NotFoundError('Run not found');
  }

  log.info('Experience run detail read', { runId, legs: run.legs.length });
  return successResponse(run);
});

export const GET = handleDetail;
