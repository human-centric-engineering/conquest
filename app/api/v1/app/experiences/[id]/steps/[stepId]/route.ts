/**
 * Experience steps (P15) — single-step endpoint.
 *
 * PATCH  /api/v1/app/experiences/:id/steps/:stepId  — edit any step field (key collision → 409).
 * DELETE /api/v1/app/experiences/:id/steps/:stepId  — remove the step.
 *
 * Both: `withAdminAuth`, then 404 unless the step exists AND belongs to the named experience —
 * the ownership check matters, otherwise `:id` would be decorative and any admin could edit any
 * step through any experience's URL.
 */

import { Prisma } from '@prisma/client';

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { updateExperienceStepSchema } from '@/lib/app/questionnaire/experiences/schemas';
import { EXPERIENCE_STEP_SELECT, toStepViews } from '@/app/api/v1/app/experiences/_lib/read';

type StepParams = { id: string; stepId: string };

/** 404 unless the step exists and belongs to this experience. */
async function requireOwnedStep(experienceId: string, stepId: string) {
  const step = await prisma.appExperienceStep.findUnique({
    where: { id: stepId },
    select: EXPERIENCE_STEP_SELECT,
  });
  if (!step || step.experienceId !== experienceId) {
    throw new NotFoundError('Experience step not found');
  }
  return step;
}

const handleUpdate = withAdminAuth<StepParams>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, stepId } = await params;

  const before = await requireOwnedStep(id, stepId);
  const body = await validateRequestBody(request, updateExperienceStepSchema);

  try {
    const updated = await prisma.appExperienceStep.update({
      where: { id: stepId },
      data: {
        // Present-key writes only: `undefined` leaves the column alone, explicit `null` clears it.
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.key !== undefined ? { key: body.key } : {}),
        ...(body.questionnaireId !== undefined
          ? { questionnaireId: body.questionnaireId ?? null }
          : {}),
        ...(body.versionId !== undefined ? { versionId: body.versionId ?? null } : {}),
        ...(body.roundId !== undefined ? { roundId: body.roundId ?? null } : {}),
        ...(body.purpose !== undefined ? { purpose: body.purpose ?? null } : {}),
        ...(body.selectionCriteria !== undefined
          ? { selectionCriteria: body.selectionCriteria ?? null }
          : {}),
        ...(body.durationSeconds !== undefined
          ? { durationSeconds: body.durationSeconds ?? null }
          : {}),
        ...(body.briefing !== undefined ? { briefing: body.briefing ?? null } : {}),
        ...(body.synthesisFocus !== undefined
          ? { synthesisFocus: body.synthesisFocus ?? null }
          : {}),
      },
      select: EXPERIENCE_STEP_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_experience_step.update',
      entityType: 'app_experience_step',
      entityId: stepId,
      entityName: updated.title,
      changes: computeChanges(before, updated),
      metadata: { experienceId: id },
      clientIp,
    });
    log.info('Experience step updated', { experienceId: id, stepId, fields: Object.keys(body) });

    const [view] = await toStepViews([updated]);
    return successResponse(view);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A step with this key already exists in this experience', {
        code: 'STEP_KEY_CONFLICT',
        status: 409,
        details: { key: [`"${body.key}" is already taken`] },
      });
    }
    throw err;
  }
});

const handleDelete = withAdminAuth<StepParams>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, stepId } = await params;

  const step = await requireOwnedStep(id, stepId);
  await prisma.appExperienceStep.delete({ where: { id: stepId } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience_step.delete',
    entityType: 'app_experience_step',
    entityId: stepId,
    entityName: step.title,
    metadata: { experienceId: id, key: step.key },
    clientIp,
  });
  log.info('Experience step deleted', { experienceId: id, stepId });

  return successResponse({ id: stepId, deleted: true });
});

export const PATCH = handleUpdate;
export const DELETE = handleDelete;
