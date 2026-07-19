/**
 * Cohorts collection endpoint.
 *
 * GET  /api/v1/app/cohorts?demoClientId=…&q=…
 *   Admin list of a demo client's cohorts, newest-first, each enriched with active-member +
 *   round counts and a completion roll-up. `demoClientId` is required (cohorts are always
 *   scoped to a client); `q` filters by name.
 *
 * POST /api/v1/app/cohorts
 *   Create a cohort under a demo client.
 *
 * Both: cohorts flag-gate first (404 when off), then `withAdminAuth`. Mutations are audited.
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { createCohortSchema } from '@/lib/app/questionnaire/rounds';
import { demoClientExists, getCohortDetail, listCohorts } from '@/app/api/v1/app/cohorts/_lib/read';

/** Bounds the list filters. `q` reaches a Prisma `contains`, so it must not be unbounded. */
const listQuerySchema = z.object({
  demoClientId: z.string().min(1).max(64),
  q: z.string().max(200).optional(),
});

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const parsed = listQuerySchema.safeParse({
    demoClientId: searchParams.get('demoClientId') ?? undefined,
    q: searchParams.get('q') ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse('demoClientId is required', { code: 'VALIDATION_ERROR', status: 400 });
  }
  const { demoClientId, q } = parsed.data;
  const cohorts = await listCohorts(demoClientId, q);
  log.info('Cohorts listed', { demoClientId, count: cohorts.length });
  return successResponse(cohorts);
});

const handleCreate = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);

  const body = await validateRequestBody(request, createCohortSchema);

  if (!(await demoClientExists(body.demoClientId))) {
    return errorResponse('Demo client not found', { code: 'DEMO_CLIENT_NOT_FOUND', status: 404 });
  }

  const created = await prisma.appCohort.create({
    data: {
      demoClientId: body.demoClientId,
      name: body.name,
      description: body.description ?? null,
      introBackground: body.introBackground ?? null,
      createdBy: session.user.id,
    },
    select: { id: true, name: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_cohort.create',
    entityType: 'app_cohort',
    entityId: created.id,
    entityName: created.name,
    metadata: { demoClientId: body.demoClientId },
    clientIp,
  });
  log.info('Cohort created', { id: created.id, demoClientId: body.demoClientId });

  // Return the enriched view so the table can prepend it without a refetch.
  const detail = await getCohortDetail(created.id);
  return successResponse(detail, undefined, { status: 201 });
});

export const GET = handleList;
export const POST = handleCreate;
