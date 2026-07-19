/**
 * Single cohort-subgroup endpoint.
 *
 * PATCH  /api/v1/app/cohorts/:id/subgroups/:subgroupId  — rename / re-describe / reorder
 *        (409 on a name clash within the cohort).
 * DELETE /api/v1/app/cohorts/:id/subgroups/:subgroupId  — hard delete. Members are unassigned
 *        automatically (AppCohortMember.subgroupId → SetNull) and any round phases that targeted
 *        it cascade away; the roster + session history are untouched.
 *
 * Both: `withAdminAuth`, then 404 on an unknown
 * subgroup (scoped to the cohort in the path). Audited.
 */

import { Prisma } from '@prisma/client';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateCohortSubgroupSchema } from '@/lib/app/questionnaire/rounds';
import { toCohortSubgroupView } from '@/app/api/v1/app/cohorts/_lib/read';

const SUBGROUP_SELECT = {
  id: true,
  cohortId: true,
  name: true,
  description: true,
  ordinal: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: { where: { status: 'active' } } } },
} as const;

type Params = { id: string; subgroupId: string };

const handleUpdate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, subgroupId } = await params;

  const before = await prisma.appCohortSubgroup.findFirst({
    where: { id: subgroupId, cohortId: id },
    select: SUBGROUP_SELECT,
  });
  if (!before) throw new NotFoundError('Cohort subgroup not found');

  const body = await validateRequestBody(request, updateCohortSubgroupSchema);

  try {
    const updated = await prisma.appCohortSubgroup.update({
      where: { id: subgroupId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
      },
      select: SUBGROUP_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_cohort_subgroup.update',
      entityType: 'app_cohort_subgroup',
      entityId: subgroupId,
      entityName: updated.name,
      changes: computeChanges(before, updated),
      clientIp,
    });
    log.info('Cohort subgroup updated', { cohortId: id, subgroupId });

    return successResponse(toCohortSubgroupView(updated));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A subgroup with this name already exists on the cohort', {
        code: 'SUBGROUP_ALREADY_EXISTS',
        status: 409,
        details: { name: ['That name is already taken'] },
      });
    }
    throw err;
  }
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, subgroupId } = await params;

  const subgroup = await prisma.appCohortSubgroup.findFirst({
    where: { id: subgroupId, cohortId: id },
    select: { id: true, name: true },
  });
  if (!subgroup) throw new NotFoundError('Cohort subgroup not found');

  await prisma.appCohortSubgroup.delete({ where: { id: subgroupId } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_subgroup.delete',
    entityType: 'app_cohort_subgroup',
    entityId: subgroupId,
    entityName: subgroup.name,
    metadata: { cohortId: id },
    clientIp,
  });
  log.info('Cohort subgroup deleted', { cohortId: id, subgroupId });

  return successResponse({ id: subgroupId });
});

export const PATCH = handleUpdate;
export const DELETE = handleDelete;
