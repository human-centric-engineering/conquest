/**
 * Rounds collection endpoint.
 *
 * GET  /api/v1/app/rounds?demoClientId=…   — every round across a client's cohorts.
 * GET  /api/v1/app/rounds?cohortId=…       — a single cohort's rounds.
 *   (one of the two scopes is required; `q` filters by name). Newest-first, enriched.
 *
 * POST /api/v1/app/rounds
 *   Create a round for a cohort. `name` defaults to the cohort name + window when omitted.
 *
 * Both: cohorts flag-gate first (404 when off), then `withAdminAuth`. Mutations are audited.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { createRoundSchema, defaultRoundName } from '@/lib/app/questionnaire/rounds';
import { getRoundDetail, listRounds } from '@/app/api/v1/app/rounds/_lib/read';

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const demoClientId = searchParams.get('demoClientId') ?? undefined;
  const cohortId = searchParams.get('cohortId') ?? undefined;
  if (!demoClientId && !cohortId) {
    return errorResponse('demoClientId or cohortId is required', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }
  const q = searchParams.get('q') ?? undefined;
  const rounds = await listRounds({ demoClientId, cohortId, q });
  log.info('Rounds listed', { demoClientId, cohortId, count: rounds.length });
  return successResponse(rounds);
});

const handleCreate = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);

  const body = await validateRequestBody(request, createRoundSchema);

  const cohort = await prisma.appCohort.findUnique({
    where: { id: body.cohortId },
    select: { id: true, name: true },
  });
  if (!cohort) {
    return errorResponse('Cohort not found', { code: 'COHORT_NOT_FOUND', status: 404 });
  }

  const opensAt = body.opensAt ?? null;
  const closesAt = body.closesAt ?? null;
  const name = body.name ?? defaultRoundName(cohort.name, opensAt, closesAt);

  const created = await prisma.appQuestionnaireRound.create({
    data: {
      cohortId: cohort.id,
      name,
      description: body.description ?? null,
      opensAt,
      closesAt,
      createdBy: session.user.id,
    },
    select: { id: true, name: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.create',
    entityType: 'app_questionnaire_round',
    entityId: created.id,
    entityName: created.name,
    metadata: { cohortId: cohort.id },
    clientIp,
  });
  log.info('Round created', { id: created.id, cohortId: cohort.id });

  const detail = await getRoundDetail(created.id);
  return successResponse(detail, undefined, { status: 201 });
});

export const GET = handleList;
export const POST = handleCreate;
