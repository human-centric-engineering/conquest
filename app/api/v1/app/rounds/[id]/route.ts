/**
 * Single round endpoint.
 *
 * GET    /api/v1/app/rounds/:id   — detail with bundled questionnaires (404 when unknown).
 * PATCH  /api/v1/app/rounds/:id   — edit name/description/window, or move status draft↔open
 *        (CLOSING is the dedicated `POST …/close`). Reopening a closed round via `status`
 *        clears the close stamp. Audited.
 * DELETE /api/v1/app/rounds/:id   — delete (cascades round items; sessions keep their
 *        plain-String roundId, treated as no-longer-gating on continue).
 *
 * All: cohorts flag-gate first (404 when off), then `withAdminAuth`, then 404 on unknown id.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { updateRoundSchema } from '@/lib/app/questionnaire/rounds';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';

type Params = { id: string };

const handleDetail = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const round = await getRoundDetail(id);
  if (!round) throw new NotFoundError('Round not found');

  log.info('Round detail read', { id });
  return successResponse(round);
});

const handleUpdate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const before = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      opensAt: true,
      closesAt: true,
    },
  });
  if (!before) throw new NotFoundError('Round not found');

  const body = await validateRequestBody(request, updateRoundSchema);

  // Cross-field window check against the MERGED state (a PATCH may set just one bound).
  const opensAt = body.opensAt !== undefined ? body.opensAt : before.opensAt;
  const closesAt = body.closesAt !== undefined ? body.closesAt : before.closesAt;
  if (opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()) {
    return errorResponse('The close date must be after the open date', {
      code: 'INVALID_WINDOW',
      status: 400,
      details: { closesAt: ['Must be after the open date'] },
    });
  }

  // Reopening (status → open/draft) clears the manual-close stamp.
  const reopening = body.status !== undefined && before.status === 'closed';

  const updated = await prisma.appQuestionnaireRound.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.opensAt !== undefined ? { opensAt: body.opensAt } : {}),
      ...(body.closesAt !== undefined ? { closesAt: body.closesAt } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(reopening ? { closedAt: null, closedBy: null } : {}),
    },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      opensAt: true,
      closesAt: true,
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.update',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(before, updated),
    clientIp,
  });
  log.info('Round updated', { id });

  const detail = await getRoundDetail(id);
  return successResponse(detail);
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  await prisma.appQuestionnaireRound.delete({ where: { id } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.delete',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: round.name,
    clientIp,
  });
  log.info('Round deleted', { id });

  return successResponse({ id, deleted: true });
});

export const GET = withCohortsEnabled(handleDetail);
export const PATCH = withCohortsEnabled(handleUpdate);
export const DELETE = withCohortsEnabled(handleDelete);
