/**
 * Single cohort-member endpoint.
 *
 * PATCH  /api/v1/app/cohorts/:id/members/:memberId
 *   Edit name/notes, or re-activate a removed member (`status: active` clears `removedAt`).
 * DELETE /api/v1/app/cohorts/:id/members/:memberId
 *   SOFT remove — sets `status: removed` + stamps `removedAt`. The row is kept so any session
 *   that points back to it survives; the access guard denies a removed member mid-round.
 *
 * Both: cohorts flag-gate first (404 when off), then `withAdminAuth`, then 404 on unknown
 * member (scoped to the cohort in the path). Audited.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateCohortMemberSchema } from '@/lib/app/questionnaire/rounds';
import { toCohortMemberView } from '@/app/api/v1/app/cohorts/_lib/read';

const MEMBER_SELECT = {
  id: true,
  cohortId: true,
  subgroupId: true,
  email: true,
  name: true,
  notes: true,
  status: true,
  addedAt: true,
  removedAt: true,
} as const;

type Params = { id: string; memberId: string };

const handleUpdate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, memberId } = await params;

  // Scope the member to the cohort in the path — a member id from another cohort is a 404.
  const before = await prisma.appCohortMember.findFirst({
    where: { id: memberId, cohortId: id },
    select: MEMBER_SELECT,
  });
  if (!before) throw new NotFoundError('Cohort member not found');

  const body = await validateRequestBody(request, updateCohortMemberSchema);

  // Subgroup assignment: a non-null target must belong to THIS cohort (else a 422). `null` unassigns.
  if (body.subgroupId) {
    const subgroup = await prisma.appCohortSubgroup.findFirst({
      where: { id: body.subgroupId, cohortId: id },
      select: { id: true },
    });
    if (!subgroup) {
      return errorResponse('That subgroup does not belong to this cohort', {
        code: 'SUBGROUP_NOT_IN_COHORT',
        status: 422,
        details: { subgroupId: ['Unknown subgroup for this cohort'] },
      });
    }
  }

  const updated = await prisma.appCohortMember.update({
    where: { id: memberId },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      // Re-activation: clear the removed stamp so the roster reads clean.
      ...(body.status === 'active' ? { status: 'active', removedAt: null } : {}),
      // Subgroup assignment (null unassigns; validated above when non-null).
      ...(body.subgroupId !== undefined ? { subgroupId: body.subgroupId } : {}),
    },
    select: MEMBER_SELECT,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_member.update',
    entityType: 'app_cohort_member',
    entityId: memberId,
    entityName: updated.email,
    changes: computeChanges(before, updated),
    clientIp,
  });
  log.info('Cohort member updated', { cohortId: id, memberId });

  return successResponse(toCohortMemberView(updated));
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, memberId } = await params;

  const member = await prisma.appCohortMember.findFirst({
    where: { id: memberId, cohortId: id },
    select: MEMBER_SELECT,
  });
  if (!member) throw new NotFoundError('Cohort member not found');

  // Soft remove — preserve the row (sessions may reference it); flip status + stamp removedAt.
  const updated = await prisma.appCohortMember.update({
    where: { id: memberId },
    data: { status: 'removed', removedAt: new Date() },
    select: MEMBER_SELECT,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort_member.remove',
    entityType: 'app_cohort_member',
    entityId: memberId,
    entityName: member.email,
    metadata: { cohortId: id },
    clientIp,
  });
  log.info('Cohort member removed', { cohortId: id, memberId });

  return successResponse(toCohortMemberView(updated));
});

export const PATCH = handleUpdate;
export const DELETE = handleDelete;
