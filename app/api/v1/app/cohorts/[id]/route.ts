/**
 * Single cohort endpoint.
 *
 * GET    /api/v1/app/cohorts/:id   — detail with roster (404 when unknown).
 * PATCH  /api/v1/app/cohorts/:id   — edit name/description (audited).
 * DELETE /api/v1/app/cohorts/:id   — delete (cascades members, rounds, round items).
 *
 * All: cohorts flag-gate first (404 when off), then `withAdminAuth`, then 404 on unknown id.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { updateCohortSchema } from '@/lib/app/questionnaire/rounds';
import { getCohortDetail } from '@/app/api/v1/app/cohorts/_lib/read';

const handleDetail = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const cohort = await getCohortDetail(id);
  if (!cohort) throw new NotFoundError('Cohort not found');

  log.info('Cohort detail read', { id });
  return successResponse(cohort);
});

const handleUpdate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const before = await prisma.appCohort.findUnique({
    where: { id },
    select: { id: true, name: true, description: true },
  });
  if (!before) throw new NotFoundError('Cohort not found');

  const body = await validateRequestBody(request, updateCohortSchema);

  const updated = await prisma.appCohort.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    },
    select: { id: true, name: true, description: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort.update',
    entityType: 'app_cohort',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(before, updated),
    clientIp,
  });
  log.info('Cohort updated', { id });

  const detail = await getCohortDetail(id);
  return successResponse(detail);
});

const handleDelete = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const cohort = await prisma.appCohort.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!cohort) throw new NotFoundError('Cohort not found');

  // Cascades members + rounds + round items (schema onDelete: Cascade). Sessions that
  // reference a deleted round via the plain-String `roundId` are left intact (no FK);
  // the continue-time guard treats a since-deleted round as no-longer-gating.
  await prisma.appCohort.delete({ where: { id } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort.delete',
    entityType: 'app_cohort',
    entityId: id,
    entityName: cohort.name,
    clientIp,
  });
  log.info('Cohort deleted', { id });

  return successResponse({ id, deleted: true });
});

export const GET = withCohortsEnabled(handleDetail);
export const PATCH = withCohortsEnabled(handleUpdate);
export const DELETE = withCohortsEnabled(handleDelete);
