/**
 * Cohort Report — read view (report kind `cohort`, F14.3).
 *
 * GET /api/v1/app/rounds/:id/cohort-report?versionId=…
 *   Admin-only. Returns the cohort-report read view for the round + bundled version: the report
 *   header (status, publish state, cost, revision count), the working-head revision's content, and
 *   the dataset the charts render against. `exists: false` when nothing has been generated yet (the
 *   UI shows "Generate" over a live data preview). Read-only — no paid work; gated by the
 *   cohort-report flag.
 *
 * Pipeline: cohort-report flag-gate (404) → withAdminAuth → 404 unknown round → 422 version not
 *   bundled → build view.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import { buildCohortReportView } from '@/lib/app/questionnaire/cohort-report';
import { assertRoundBundlesVersion } from '@/app/api/v1/app/rounds/_lib/context';

type Params = { id: string };

const querySchema = z.object({ versionId: z.string().min(1).max(64) });

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

  const view = await buildCohortReportView({ roundId, roundName: round.name, versionId });
  log.info('Cohort report view loaded', { roundId, versionId, exists: view.exists });
  return successResponse(view);
});

export const GET = withCohortReportEnabled(handleGet);
