/**
 * Version-wide Report — analytical dataset (report kind `cohort`, version scope).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/cohort-report/dataset
 *   Admin-only. Builds the cross-respondent dataset over ALL of the version's non-preview sessions
 *   (every round AND open-ended sessions): overall per-question distributions plus per-demographic-
 *   segment distributions. Reuses the F8.1/F8.3 distribution + k-anonymity machinery, so every segment
 *   below the floor is suppressed. Read-only — no paid LLM work; gated by the cohort-report flag.
 *
 * Pipeline: cohort-report flag-gate (404 when off) → withAdminAuth → 404 unknown version → build
 *   dataset.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import { buildCohortDataset } from '@/lib/app/questionnaire/cohort-report';
import { loadVersionReportScope } from '@/app/api/v1/app/questionnaires/_lib/version-report';

type Params = { id: string; vid: string };

const handleGet = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, vid } = await params;

  const resolved = await loadVersionReportScope(id, vid);
  if (!resolved) throw new NotFoundError('Questionnaire version not found');

  const dataset = await buildCohortDataset(resolved.scope);
  log.info('Version report dataset computed', {
    questionnaireId: id,
    versionId: vid,
    totalSessions: dataset.totalSessions,
    segmentDimensions: dataset.segmentation.length,
  });

  return successResponse(dataset);
});

export const GET = withCohortReportEnabled(handleGet);
