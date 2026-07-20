/**
 * Experience steps (P15) — collection endpoint.
 *
 * GET  /api/v1/app/experiences/:id/steps   — ordered steps with resolved questionnaire titles.
 * POST /api/v1/app/experiences/:id/steps   — append a step. `key` is optional; omitted, it is
 *      derived from the title and de-duplicated against siblings.
 *
 * Both: `withAdminAuth`, then 404 on unknown experience.
 */

import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { createExperienceStepSchema } from '@/lib/app/questionnaire/experiences/schemas';
import { EXPERIENCE_STEP_SELECT, toStepViews } from '@/app/api/v1/app/experiences/_lib/read';
import { deriveStepKey, nextStepOrdinal } from '@/app/api/v1/app/experiences/_lib/steps';

/** 404 unless the experience exists. Returns its title for the audit entry. */
async function requireExperience(id: string): Promise<{ id: string; title: string }> {
  const experience = await prisma.appExperience.findUnique({
    where: { id },
    select: { id: true, title: true },
  });
  if (!experience) {
    throw new NotFoundError('Experience not found');
  }
  return experience;
}

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  await requireExperience(id);

  const steps = await prisma.appExperienceStep.findMany({
    where: { experienceId: id },
    orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
    select: EXPERIENCE_STEP_SELECT,
  });

  const views = await toStepViews(steps);
  log.info('Experience steps listed', { experienceId: id, count: views.length });
  return successResponse(views);
});

const handleCreate = withAdminAuth<{ id: string }>(
  async (request: NextRequest, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id } = await params;
    const experience = await requireExperience(id);

    const body = await validateRequestBody(request, createExperienceStepSchema);
    const key = body.key ?? (await deriveStepKey(id, body.title));

    try {
      const created = await prisma.appExperienceStep.create({
        data: {
          experienceId: id,
          key,
          kind: body.kind,
          title: body.title,
          questionnaireId: body.questionnaireId ?? null,
          versionId: body.versionId ?? null,
          roundId: body.roundId ?? null,
          purpose: body.purpose ?? null,
          selectionCriteria: body.selectionCriteria ?? null,
          // Facilitated-meeting breakout meta (P15.5). Harmless on other step kinds — an author
          // switching a step's kind keeps whatever they had typed rather than losing it.
          durationSeconds: body.durationSeconds ?? null,
          briefing: body.briefing ?? null,
          synthesisFocus: body.synthesisFocus ?? null,
          ordinal: await nextStepOrdinal(id),
        },
        select: EXPERIENCE_STEP_SELECT,
      });

      logAdminAction({
        userId: session.user.id,
        action: 'app_experience_step.create',
        entityType: 'app_experience_step',
        entityId: created.id,
        entityName: created.title,
        metadata: { experienceId: id, experienceName: experience.title, key, kind: created.kind },
        clientIp,
      });
      log.info('Experience step created', { experienceId: id, stepId: created.id, key });

      const [view] = await toStepViews([created]);
      return successResponse(view, undefined, { status: 201 });
    } catch (err) {
      // Either an explicitly supplied key collided, or two concurrent creates derived the same
      // one — the unique constraint is the arbiter in both cases (see deriveStepKey).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return errorResponse('A step with this key already exists in this experience', {
          code: 'STEP_KEY_CONFLICT',
          status: 409,
          details: { key: [`"${key}" is already taken`] },
        });
      }
      throw err;
    }
  }
);

export const GET = handleList;
export const POST = handleCreate;
