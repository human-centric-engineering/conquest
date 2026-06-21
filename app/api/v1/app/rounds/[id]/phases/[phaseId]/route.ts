/**
 * Single round-phase endpoint.
 *
 * PATCH  /api/v1/app/rounds/:id/phases/:phaseId  — edit the window / end mode / order. 422 when the
 *        resulting window no longer nests inside the round window. `subgroupId` is immutable.
 * DELETE /api/v1/app/rounds/:id/phases/:phaseId  — remove the phase; the subgroup's members fall back
 *        to the round's own window.
 *
 * Both: round-phases flag-gate first (404 when off), then `withAdminAuth`, then 404 on an unknown
 * phase (scoped to the round in the path). Audited.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withRoundPhasesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  ROUND_PHASE_END_MODES,
  updateRoundPhaseSchema,
  validatePhaseWindowNesting,
} from '@/lib/app/questionnaire/rounds';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';

type Params = { id: string; phaseId: string };

const handleUpdate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, phaseId } = await params;

  // Scope the phase to the round, and pull the round window for the nesting check.
  const before = await prisma.appRoundPhase.findFirst({
    where: { id: phaseId, roundId: id },
    select: {
      id: true,
      subgroupId: true,
      opensAt: true,
      closesAt: true,
      endMode: true,
      ordinal: true,
      round: { select: { name: true, opensAt: true, closesAt: true } },
    },
  });
  if (!before) throw new NotFoundError('Round phase not found');

  const body = await validateRequestBody(request, updateRoundPhaseSchema);

  // Overlay the patch onto the stored window, then validate the result nests in the round window.
  const nextOpensAt = body.opensAt !== undefined ? body.opensAt : before.opensAt;
  const nextClosesAt = body.closesAt !== undefined ? body.closesAt : before.closesAt;
  const nesting = validatePhaseWindowNesting(
    { opensAt: before.round.opensAt, closesAt: before.round.closesAt },
    { opensAt: nextOpensAt, closesAt: nextClosesAt }
  );
  if (!nesting.ok) {
    return errorResponse(nesting.message, {
      code: 'PHASE_WINDOW_NOT_NESTED',
      status: 422,
      details: { closesAt: [nesting.message] },
    });
  }

  const updated = await prisma.appRoundPhase.update({
    where: { id: phaseId },
    data: {
      ...(body.opensAt !== undefined ? { opensAt: body.opensAt } : {}),
      ...(body.closesAt !== undefined ? { closesAt: body.closesAt } : {}),
      ...(body.endMode !== undefined ? { endMode: body.endMode } : {}),
      ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
    },
    select: { id: true, opensAt: true, closesAt: true, endMode: true, ordinal: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.update_phase',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: before.round.name,
    changes: computeChanges(
      {
        opensAt: before.opensAt,
        closesAt: before.closesAt,
        endMode: narrowToEnum(before.endMode, ROUND_PHASE_END_MODES, 'hard'),
        ordinal: before.ordinal,
      },
      updated
    ),
    metadata: { phaseId, subgroupId: before.subgroupId },
    clientIp,
  });
  log.info('Round phase updated', { roundId: id, phaseId });

  const detail = await getRoundDetail(id);
  return successResponse(detail);
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, phaseId } = await params;

  const phase = await prisma.appRoundPhase.findFirst({
    where: { id: phaseId, roundId: id },
    select: { id: true, subgroupId: true, round: { select: { name: true } } },
  });
  if (!phase) throw new NotFoundError('Round phase not found');

  await prisma.appRoundPhase.delete({ where: { id: phaseId } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.remove_phase',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: phase.round.name,
    metadata: { phaseId, subgroupId: phase.subgroupId },
    clientIp,
  });
  log.info('Round phase deleted', { roundId: id, phaseId });

  return successResponse({ id: phaseId });
});

export const PATCH = withRoundPhasesEnabled(handleUpdate);
export const DELETE = withRoundPhasesEnabled(handleDelete);
