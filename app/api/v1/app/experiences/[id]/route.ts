/**
 * Experiences (P15) — single-experience endpoint.
 *
 * GET    /api/v1/app/experiences/:id   — detail with ordered steps (404 when unknown).
 * PATCH  /api/v1/app/experiences/:id   — edit identity, routing policy, budget, access, settings.
 * DELETE /api/v1/app/experiences/:id   — delete, REFUSED with 409 once the experience has left
 *        draft (see below).
 *
 * All: `withAdminAuth`, then 404 on unknown id.
 */

import { NotFoundError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { updateExperienceSchema } from '@/lib/app/questionnaire/experiences/schemas';
import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import {
  EXPERIENCE_SELECT,
  getExperienceDetail,
  toListView,
} from '@/app/api/v1/app/experiences/_lib/read';

const handleDetail = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const experience = await getExperienceDetail(id);
  if (!experience) {
    throw new NotFoundError('Experience not found');
  }

  log.info('Experience detail read', { id, steps: experience.steps.length });
  return successResponse(experience);
});

const handleUpdate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const before = await prisma.appExperience.findUnique({
    where: { id },
    select: EXPERIENCE_SELECT,
  });
  if (!before) {
    throw new NotFoundError('Experience not found');
  }

  const body = await validateRequestBody(request, updateExperienceSchema);

  // Settings arrive as a PARTIAL patch, so merge onto the narrowed current value rather than
  // replacing the column. Narrowing first means a row written under an older shape is upgraded to
  // the current one on its next write, instead of the patch merging onto raw legacy keys.
  const settings =
    body.settings !== undefined
      ? { ...narrowExperienceSettings(before.settings), ...body.settings }
      : undefined;

  const updated = await prisma.appExperience.update({
    where: { id },
    data: {
      // Each key is written only when present: `undefined` leaves the column alone, while an
      // explicit `null` on a nullable field clears it. That distinction is why the schema uses
      // `.nullish()` rather than `.optional()` on those fields.
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description ?? null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.continuityMode !== undefined ? { continuityMode: body.continuityMode } : {}),
      ...(body.routingFallback !== undefined ? { routingFallback: body.routingFallback } : {}),
      ...(body.minRoutingConfidence !== undefined
        ? { minRoutingConfidence: body.minRoutingConfidence }
        : {}),
      ...(body.routingInstructions !== undefined
        ? { routingInstructions: body.routingInstructions ?? null }
        : {}),
      ...(body.costBudgetUsd !== undefined ? { costBudgetUsd: body.costBudgetUsd ?? null } : {}),
      ...(body.accessMode !== undefined ? { accessMode: body.accessMode } : {}),
      ...(body.cohortId !== undefined ? { cohortId: body.cohortId ?? null } : {}),
      ...(settings !== undefined ? { settings } : {}),
    },
    select: EXPERIENCE_SELECT,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience.update',
    entityType: 'app_experience',
    entityId: id,
    entityName: updated.title,
    changes: computeChanges(before, updated),
    clientIp,
  });
  log.info('Experience updated', { id, fields: Object.keys(body) });

  return successResponse(toListView(updated));
});

const handleDelete = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const existing = await prisma.appExperience.findUnique({
    where: { id },
    select: { id: true, title: true, status: true },
  });
  if (!existing) {
    throw new NotFoundError('Experience not found');
  }

  // Deleting cascades to steps and (from P15.2) runs and legs — which is respondent history. A
  // launched or archived experience has plausibly been run by someone, so deletion is refused and
  // archiving offered instead. Draft experiences have no runs by construction and delete freely.
  if (existing.status !== 'draft') {
    return errorResponse('Only draft experiences can be deleted', {
      code: 'EXPERIENCE_NOT_DRAFT',
      status: 409,
      details: {
        status: [
          `This experience is ${existing.status}. Archive it instead — deleting would remove any respondent history attached to it.`,
        ],
      },
    });
  }

  await prisma.appExperience.delete({ where: { id } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience.delete',
    entityType: 'app_experience',
    entityId: id,
    entityName: existing.title,
    clientIp,
  });
  log.info('Experience deleted', { id });

  return successResponse({ id, deleted: true });
});

export const GET = handleDetail;
export const PATCH = handleUpdate;
export const DELETE = handleDelete;
