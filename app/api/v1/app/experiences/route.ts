/**
 * Experiences (P15) — collection endpoint.
 *
 * GET  /api/v1/app/experiences
 *   Admin-only list of every experience, newest-first, each with its demo-client name and step
 *   count. Optional `status`, `kind` and `demoClientId` filters.
 *
 * POST /api/v1/app/experiences
 *   Create an experience. Only the demo client, title and kind are required — routing policy,
 *   budget and settings all have defaults and are edited on the Settings tab afterwards.
 *
 * Both: `withAdminAuth` (the section rate-limit cap is already applied by `proxy.ts`; handlers add
 * sub-caps only for expensive flows, and neither of these is one). Mutations are audited.
 */

import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import {
  createExperienceSchema,
  listExperiencesQuerySchema,
} from '@/lib/app/questionnaire/experiences/schemas';
import {
  EXPERIENCE_SELECT,
  listExperiences,
  toListView,
} from '@/app/api/v1/app/experiences/_lib/read';

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);

  const url = new URL(request.url);
  const parsed = listExperiencesQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    demoClientId: url.searchParams.get('demoClientId') ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse('Invalid filters', {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const experiences = await listExperiences(parsed.data);
  log.info('Experiences listed', { count: experiences.length });
  return successResponse(experiences);
});

const handleCreate = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);

  const body = await validateRequestBody(request, createExperienceSchema);

  try {
    const created = await prisma.appExperience.create({
      data: {
        demoClientId: body.demoClientId,
        title: body.title,
        kind: body.kind,
        description: body.description ?? null,
        createdBy: session.user.id,
        // Absent keys leave the schema defaults in place rather than restating them here — one
        // source of truth for what a fresh experience looks like.
        ...(body.continuityMode !== undefined ? { continuityMode: body.continuityMode } : {}),
        ...(body.accessMode !== undefined ? { accessMode: body.accessMode } : {}),
        ...(body.cohortId !== undefined ? { cohortId: body.cohortId ?? null } : {}),
      },
      select: EXPERIENCE_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'app_experience.create',
      entityType: 'app_experience',
      entityId: created.id,
      entityName: created.title,
      metadata: { kind: created.kind },
      clientIp,
    });
    log.info('Experience created', { id: created.id, kind: created.kind });

    return successResponse(toListView(created), undefined, { status: 201 });
  } catch (err) {
    // The only FK on the model is demoClientId, so a P2003 here means the client does not exist.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      return errorResponse('That demo client does not exist', {
        code: 'DEMO_CLIENT_NOT_FOUND',
        status: 400,
        details: { demoClientId: ['Unknown demo client'] },
      });
    }
    throw err;
  }
});

export const GET = handleList;
export const POST = handleCreate;
