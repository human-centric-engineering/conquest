/**
 * Detach one questionnaire from a round.
 *
 * DELETE /api/v1/app/rounds/:id/questionnaires/:itemId
 *   Removes the round-item (scoped to the round in the path → 404 otherwise). Audited.
 *
 * Cohorts flag-gate first (404 when off), then `withAdminAuth`.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';

type Params = { id: string; itemId: string };

const handleDetach = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, itemId } = await params;

  const item = await prisma.appQuestionnaireRoundItem.findFirst({
    where: { id: itemId, roundId: id },
    select: { id: true, questionnaireId: true },
  });
  if (!item) throw new NotFoundError('Round questionnaire not found');

  await prisma.appQuestionnaireRoundItem.delete({ where: { id: itemId } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.detach_questionnaire',
    entityType: 'app_questionnaire_round',
    entityId: id,
    metadata: { questionnaireId: item.questionnaireId, itemId },
    clientIp,
  });
  log.info('Questionnaire detached from round', { id, itemId });

  const detail = await getRoundDetail(id);
  return successResponse(detail);
});

export const DELETE = handleDetach;
