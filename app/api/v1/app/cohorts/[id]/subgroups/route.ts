/**
 * Cohort subgroups collection endpoint.
 *
 * GET  /api/v1/app/cohorts/:id/subgroups  — the cohort's subgroups (by ordinal, then name),
 *      404 when the cohort is unknown.
 * POST /api/v1/app/cohorts/:id/subgroups  — create one subgroup (409 when the name is already
 *      taken on this cohort — `@@unique([cohortId, name])`).
 *
 * Both: cohorts flag-gate first (404 when off), then `withAdminAuth`. Creates are audited.
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

import { createCohortSubgroupSchema } from '@/lib/app/questionnaire/rounds';
import { listCohortSubgroups, toCohortSubgroupView } from '@/app/api/v1/app/cohorts/_lib/read';

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const subgroups = await listCohortSubgroups(id);
  if (subgroups === null) throw new NotFoundError('Cohort not found');

  log.info('Cohort subgroups listed', { cohortId: id, count: subgroups.length });
  return successResponse(subgroups);
});

const handleCreate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const cohort = await prisma.appCohort.findUnique({ where: { id }, select: { id: true } });
  if (!cohort) throw new NotFoundError('Cohort not found');

  const body = await validateRequestBody(request, createCohortSubgroupSchema);

  try {
    const created = await prisma.appCohortSubgroup.create({
      data: {
        cohortId: id,
        name: body.name,
        description: body.description ?? null,
        ordinal: body.ordinal ?? 0,
        createdBy: session.user.id,
      },
      select: {
        id: true,
        cohortId: true,
        name: true,
        description: true,
        ordinal: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { members: { where: { status: 'active' } } } },
      },
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_cohort_subgroup.create',
      entityType: 'app_cohort_subgroup',
      entityId: created.id,
      entityName: created.name,
      metadata: { cohortId: id },
      clientIp,
    });
    log.info('Cohort subgroup created', { cohortId: id, subgroupId: created.id });

    return successResponse(toCohortSubgroupView(created), undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A subgroup with this name already exists on the cohort', {
        code: 'SUBGROUP_ALREADY_EXISTS',
        status: 409,
        details: { name: [`${body.name} is already a subgroup`] },
      });
    }
    throw err;
  }
});

export const GET = handleList;
export const POST = handleCreate;
