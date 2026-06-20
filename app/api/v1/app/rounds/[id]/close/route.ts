/**
 * Manually close a round.
 *
 * POST /api/v1/app/rounds/:id/close
 *   Admin action — moves the round to `closed`, stamping `closedAt` + `closedBy`. From that
 *   point the access guard denies any new or continuing session in the round (the continue
 *   path auto-pauses an in-flight session). Idempotent guard: closing an already-closed round
 *   is a 409. Reopening is a `PATCH … { status: 'open' }`.
 *
 * Cohorts flag-gate first (404 when off), then `withAdminAuth`. Audited.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';

const handleClose = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true, name: true, status: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  if (round.status === 'closed') {
    return errorResponse('This round is already closed', {
      code: 'ROUND_ALREADY_CLOSED',
      status: 409,
    });
  }

  await prisma.appQuestionnaireRound.update({
    where: { id },
    data: { status: 'closed', closedAt: new Date(), closedBy: session.user.id },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.close',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: round.name,
    metadata: { fromStatus: round.status },
    clientIp,
  });
  log.info('Round closed', { id });

  const detail = await getRoundDetail(id);
  return successResponse(detail);
});

export const POST = withCohortsEnabled(handleClose);
