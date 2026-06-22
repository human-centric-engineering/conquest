/**
 * Round phases collection endpoint — staggered access windows for cohort subgroups.
 *
 * GET  /api/v1/app/rounds/:id/phases   — the round's phases (ordered), 404 when the round is unknown.
 * POST /api/v1/app/rounds/:id/phases   — add a phase for one subgroup. 409 when the subgroup already
 *      has a phase on this round (`@@unique([roundId, subgroupId])`); 422 when the subgroup is not in
 *      the round's cohort or the window does not nest inside the round window.
 *
 * Both: round-phases flag-gate first (404 when off), then `withAdminAuth`. Creates are audited.
 */

import { Prisma } from '@prisma/client';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withRoundPhasesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { createRoundPhaseSchema, validatePhaseWindowNesting } from '@/lib/app/questionnaire/rounds';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const detail = await getRoundDetail(id);
  if (!detail) throw new NotFoundError('Round not found');

  log.info('Round phases listed', { roundId: id, count: detail.phases.length });
  return successResponse(detail.phases);
});

const handleCreate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true, name: true, cohortId: true, opensAt: true, closesAt: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const body = await validateRequestBody(request, createRoundPhaseSchema);

  // The subgroup must belong to the round's cohort.
  const subgroup = await prisma.appCohortSubgroup.findFirst({
    where: { id: body.subgroupId, cohortId: round.cohortId },
    select: { id: true, name: true },
  });
  if (!subgroup) {
    return errorResponse('That subgroup does not belong to this round’s cohort', {
      code: 'SUBGROUP_NOT_IN_COHORT',
      status: 422,
      details: { subgroupId: ['Unknown subgroup for this cohort'] },
    });
  }

  // The phase window must nest inside the round window.
  const nesting = validatePhaseWindowNesting(round, {
    opensAt: body.opensAt ?? null,
    closesAt: body.closesAt ?? null,
  });
  if (!nesting.ok) {
    return errorResponse(nesting.message, {
      code: 'PHASE_WINDOW_NOT_NESTED',
      status: 422,
      details: { closesAt: [nesting.message] },
    });
  }

  try {
    await prisma.appRoundPhase.create({
      data: {
        roundId: id,
        subgroupId: body.subgroupId,
        opensAt: body.opensAt ?? null,
        closesAt: body.closesAt ?? null,
        endMode: body.endMode ?? 'hard',
        ordinal: body.ordinal ?? 0,
        createdBy: session.user.id,
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('This subgroup already has a phase on the round', {
        code: 'PHASE_ALREADY_EXISTS',
        status: 409,
      });
    }
    throw err;
  }

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.add_phase',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: round.name,
    metadata: { subgroupId: body.subgroupId, subgroupName: subgroup.name },
    clientIp,
  });
  log.info('Round phase created', { roundId: id, subgroupId: body.subgroupId });

  const detail = await getRoundDetail(id);
  return successResponse(detail, undefined, { status: 201 });
});

export const GET = withRoundPhasesEnabled(handleList);
export const POST = withRoundPhasesEnabled(handleCreate);
