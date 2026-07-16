/**
 * Cohort Report — analytical dataset (report kind `cohort`, F14.1).
 *
 * GET /api/v1/app/rounds/:id/cohort-report/dataset?versionId=…
 *   Admin-only. Builds the cross-respondent dataset over the round's non-preview sessions for the
 *   given bundled version: overall per-question distributions plus per-demographic-segment
 *   distributions (by `profileFields` of type select/number, and by cohort subgroup). Reuses the
 *   F8.1/F8.3 distribution + k-anonymity machinery, so every segment below the floor is suppressed.
 *   Read-only — no paid LLM work; gated by the cohort-report flag (which ANDs the master + cohorts
 *   flags). `versionId` is required and validated to be one the round actually bundles.
 *
 * Pipeline: cohort-report flag-gate (404 when off) → withAdminAuth → 404 on unknown round →
 *   422 when the version isn't bundled by the round → build dataset.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { buildCohortDataset, roundScope } from '@/lib/app/questionnaire/cohort-report';
import { assertRoundBundlesVersion } from '@/app/api/v1/app/rounds/_lib/context';

type Params = { id: string };

const querySchema = z.object({
  /** The bundled version whose sessions to analyse. Required — a round may bundle several. */
  versionId: z.string().min(1).max(64),
});

const handleGet = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: roundId } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const { searchParams } = new URL(request.url);
  const { versionId } = validateQueryParams(searchParams, querySchema);

  if (!(await assertRoundBundlesVersion(roundId, versionId))) {
    return errorResponse('Version is not bundled by this round', {
      code: 'VERSION_NOT_IN_ROUND',
      status: 422,
    });
  }

  const dataset = await buildCohortDataset(roundScope(roundId, versionId, round.name));
  log.info('Cohort report dataset computed', {
    roundId,
    versionId,
    totalSessions: dataset.totalSessions,
    segmentDimensions: dataset.segmentation.length,
  });

  return successResponse(dataset);
});

export const GET = handleGet;
