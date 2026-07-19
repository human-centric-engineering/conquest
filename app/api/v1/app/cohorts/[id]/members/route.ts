/**
 * Cohort roster endpoint.
 *
 * GET  /api/v1/app/cohorts/:id/members   — the cohort's roster (active first), 404 when unknown.
 * POST /api/v1/app/cohorts/:id/members   — add one person (409 when their email is already on
 *      this cohort's roster — `@@unique([cohortId, email])`).
 *
 * Both: `withAdminAuth`. Adds are audited.
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

import { createCohortMemberSchema } from '@/lib/app/questionnaire/rounds';
import { listCohortMembers, toCohortMemberView } from '@/app/api/v1/app/cohorts/_lib/read';

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const members = await listCohortMembers(id);
  if (members === null) throw new NotFoundError('Cohort not found');

  log.info('Cohort members listed', { cohortId: id, count: members.length });
  return successResponse(members);
});

const handleCreate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const cohort = await prisma.appCohort.findUnique({ where: { id }, select: { id: true } });
  if (!cohort) throw new NotFoundError('Cohort not found');

  const body = await validateRequestBody(request, createCohortMemberSchema);

  try {
    const created = await prisma.appCohortMember.create({
      data: {
        cohortId: id,
        email: body.email,
        name: body.name,
        notes: body.notes ?? null,
      },
      select: {
        id: true,
        cohortId: true,
        subgroupId: true,
        email: true,
        name: true,
        notes: true,
        status: true,
        addedAt: true,
        removedAt: true,
      },
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_cohort_member.add',
      entityType: 'app_cohort_member',
      entityId: created.id,
      entityName: created.email,
      metadata: { cohortId: id },
      clientIp,
    });
    log.info('Cohort member added', { cohortId: id, memberId: created.id });

    return successResponse(toCohortMemberView(created), undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('This email is already on the cohort roster', {
        code: 'MEMBER_ALREADY_EXISTS',
        status: 409,
        details: { email: [`${body.email} is already a member`] },
      });
    }
    throw err;
  }
});

export const GET = handleList;
export const POST = handleCreate;
