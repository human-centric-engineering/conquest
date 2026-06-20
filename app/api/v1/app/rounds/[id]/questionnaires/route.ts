/**
 * Round → questionnaire bundle endpoint.
 *
 * POST /api/v1/app/rounds/:id/questionnaires
 *   Attach a questionnaire to the round (optionally pinning a version). A round bundles
 *   DISTINCT questionnaires — re-attaching the same one is a 409
 *   (`@@unique([roundId, questionnaireId])`).
 *
 * Cohorts flag-gate first (404 when off), then `withAdminAuth`. Audited.
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

import { withCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { attachRoundQuestionnaireSchema } from '@/lib/app/questionnaire/rounds';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';

const handleAttach = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const body = await validateRequestBody(request, attachRoundQuestionnaireSchema);

  const questionnaire = await prisma.appQuestionnaire.findUnique({
    where: { id: body.questionnaireId },
    select: { id: true, title: true },
  });
  if (!questionnaire) {
    return errorResponse('Questionnaire not found', {
      code: 'QUESTIONNAIRE_NOT_FOUND',
      status: 404,
    });
  }

  // A pinned version must belong to the questionnaire being attached.
  if (body.versionId) {
    const version = await prisma.appQuestionnaireVersion.findFirst({
      where: { id: body.versionId, questionnaireId: body.questionnaireId },
      select: { id: true },
    });
    if (!version) {
      return errorResponse('That version does not belong to this questionnaire', {
        code: 'VERSION_MISMATCH',
        status: 400,
      });
    }
  }

  try {
    await prisma.appQuestionnaireRoundItem.create({
      data: {
        roundId: id,
        questionnaireId: body.questionnaireId,
        versionId: body.versionId ?? null,
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('This questionnaire is already in the round', {
        code: 'QUESTIONNAIRE_ALREADY_IN_ROUND',
        status: 409,
      });
    }
    throw err;
  }

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.attach_questionnaire',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: round.name,
    metadata: { questionnaireId: body.questionnaireId, versionId: body.versionId ?? null },
    clientIp,
  });
  log.info('Questionnaire attached to round', { id, questionnaireId: body.questionnaireId });

  const detail = await getRoundDetail(id);
  return successResponse(detail, undefined, { status: 201 });
});

export const POST = withCohortsEnabled(handleAttach);
