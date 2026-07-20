/**
 * One breakout room — edit or remove (P15.5b).
 *
 * Deleting a room does NOT cascade to the answers given in it: `AppExperienceRunLeg.roomId` is an
 * unmodelled pointer (UG-1) precisely so an author tidying up a draft agenda cannot destroy the
 * record of a meeting that already ran. Those legs keep pointing at an id that no longer resolves,
 * and the reads render it as a missing room.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { BREAKOUT_ROOM_MODES } from '@/lib/app/questionnaire/experiences/meeting/types';

type Params = { id: string; stepId: string; roomId: string };

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    mode: z.enum(BREAKOUT_ROOM_MODES),
    questionnaireId: z.string().min(1).max(64).nullish(),
    versionId: z.string().min(1).max(64).nullish(),
    ordinal: z.number().int().min(0),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** Scoped by all three ids: a room from another experience or step must 404. */
async function loadRoom(experienceId: string, stepId: string, roomId: string) {
  return prisma.appExperienceBreakoutRoom.findFirst({
    where: { id: roomId, stepId, step: { experienceId } },
    select: { id: true },
  });
}

const handlePatch = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, stepId, roomId } = await params;
  if (!(await loadRoom(id, stepId, roomId))) throw new NotFoundError('Room not found');

  const body = await validateRequestBody(request, patchSchema);
  try {
    const room = await prisma.appExperienceBreakoutRoom.update({
      where: { id: roomId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.questionnaireId !== undefined
          ? { questionnaireId: body.questionnaireId ?? null }
          : {}),
        ...(body.versionId !== undefined ? { versionId: body.versionId ?? null } : {}),
        ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
      },
    });
    log.info('Breakout room updated', { experienceId: id, stepId, roomId });
    return successResponse(room);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A room with that name already exists in this breakout', {
        code: 'CONFLICT',
        status: 409,
      });
    }
    throw err;
  }
});

const handleDelete = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, stepId, roomId } = await params;
  if (!(await loadRoom(id, stepId, roomId))) throw new NotFoundError('Room not found');

  await prisma.appExperienceBreakoutRoom.delete({ where: { id: roomId } });
  log.info('Breakout room deleted', { experienceId: id, stepId, roomId });
  return successResponse({ id: roomId });
});

export const PATCH = handlePatch;
export const DELETE = handleDelete;
