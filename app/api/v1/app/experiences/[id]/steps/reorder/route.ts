/**
 * Experience steps (P15) — reorder endpoint.
 *
 * PATCH /api/v1/app/experiences/:id/steps/reorder
 *   Body: `{ stepIds: [...] }` — the COMPLETE ordered list of this experience's step ids.
 *
 * Requires the full list rather than a moved-item delta, and rejects any list that is not exactly
 * the experience's current step set. That makes a stale client impossible to apply silently: if
 * another admin added or removed a step since this page loaded, the request 409s instead of
 * writing an order derived from a set that no longer exists. A delta would let two concurrent
 * drags interleave into an order neither author chose.
 *
 * `withAdminAuth`, then 404 on unknown experience.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { reorderExperienceStepsSchema } from '@/lib/app/questionnaire/experiences/schemas';
import { EXPERIENCE_STEP_SELECT, toStepViews } from '@/app/api/v1/app/experiences/_lib/read';

const handleReorder = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const experience = await prisma.appExperience.findUnique({
    where: { id },
    select: { id: true, title: true },
  });
  if (!experience) {
    throw new NotFoundError('Experience not found');
  }

  const body = await validateRequestBody(request, reorderExperienceStepsSchema);

  const current = await prisma.appExperienceStep.findMany({
    where: { experienceId: id },
    select: { id: true },
  });

  const currentIds = new Set(current.map((s) => s.id));
  const submitted = new Set(body.stepIds);

  // Three ways a list can be wrong, each reported distinctly so the client can tell "your page is
  // stale" from "you sent a duplicate" from "that step isn't ours".
  if (submitted.size !== body.stepIds.length) {
    return errorResponse('The step order contains duplicate ids', {
      code: 'DUPLICATE_STEP_IDS',
      status: 400,
    });
  }
  const foreign = body.stepIds.filter((stepId) => !currentIds.has(stepId));
  if (foreign.length > 0) {
    return errorResponse('The step order references steps that do not belong to this experience', {
      code: 'UNKNOWN_STEP_IDS',
      status: 400,
      details: { stepIds: foreign },
    });
  }
  if (submitted.size !== currentIds.size) {
    return errorResponse(
      'The step order is out of date — this experience has changed since the page loaded',
      {
        code: 'STEP_SET_MISMATCH',
        status: 409,
        details: { expected: [`${currentIds.size} steps`], received: [`${submitted.size} steps`] },
      }
    );
  }

  // One transaction: a partial reorder would leave duplicate ordinals, and the list would render
  // in an order no author chose.
  await prisma.$transaction(
    body.stepIds.map((stepId, ordinal) =>
      prisma.appExperienceStep.update({ where: { id: stepId }, data: { ordinal } })
    )
  );

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience_step.reorder',
    entityType: 'app_experience',
    entityId: id,
    entityName: experience.title,
    metadata: { stepCount: body.stepIds.length },
    clientIp,
  });
  log.info('Experience steps reordered', { experienceId: id, count: body.stepIds.length });

  const steps = await prisma.appExperienceStep.findMany({
    where: { experienceId: id },
    orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
    select: EXPERIENCE_STEP_SELECT,
  });
  return successResponse(await toStepViews(steps));
});

export const PATCH = handleReorder;
