/**
 * Experience-step Report — analytical dataset (report kind `cohort`, experience_step scope — F15.4).
 *
 * GET /api/v1/app/experiences/:id/steps/:stepId/cohort-report/dataset
 *   Admin-only. Builds the cross-respondent dataset over ALL of the version's non-preview sessions
 *   (every round AND open-ended sessions): overall per-question distributions plus per-demographic-
 *   segment distributions. Reuses the F8.1/F8.3 distribution + k-anonymity machinery, so every segment
 *   below the floor is suppressed. Read-only — no paid LLM work.
 *
 * Pipeline: withAdminAuth → 404 unknown version → build dataset.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';

import { buildCohortDataset } from '@/lib/app/questionnaire/cohort-report';
import { loadStepReportScope } from '@/app/api/v1/app/experiences/_lib/step-report';

type Params = { id: string; stepId: string };

const handleGet = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, stepId } = await params;

  const resolved = await loadStepReportScope(id, stepId);
  if (!resolved) throw new NotFoundError('Experience step not found');

  const dataset = await buildCohortDataset(resolved.scope);
  log.info('Step report dataset computed', {
    experienceId: id,
    stepId,
    totalSessions: dataset.totalSessions,
    segmentDimensions: dataset.segmentation.length,
  });

  return successResponse(dataset);
});

export const GET = handleGet;
