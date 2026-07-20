/**
 * Authoring the rooms of a breakout (P15.5b).
 *
 * GET  — this breakout's rooms.
 * POST — add one.
 *
 * Admin-only: rooms are part of the agenda, authored before the meeting. The respondent-facing
 * `/meetings/:id/rooms` is a different route with a different audience — it reports live occupancy
 * and lets a participant pick one.
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

type Params = { id: string; stepId: string };

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(BREAKOUT_ROOM_MODES).optional(),
  /** Null inherits the breakout step's questionnaire — the common case even when rooms exist. */
  questionnaireId: z.string().min(1).max(64).nullish(),
  versionId: z.string().min(1).max(64).nullish(),
});

/** The step must belong to this experience AND be a breakout — rooms mean nothing elsewhere. */
async function loadBreakoutStep(experienceId: string, stepId: string) {
  return prisma.appExperienceStep.findFirst({
    where: { id: stepId, experienceId, kind: 'breakout' },
    select: { id: true },
  });
}

const handleList = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id, stepId } = await params;
  const step = await loadBreakoutStep(id, stepId);
  if (!step) throw new NotFoundError('Breakout not found');

  const rooms = await prisma.appExperienceBreakoutRoom.findMany({
    where: { stepId },
    orderBy: { ordinal: 'asc' },
  });
  return successResponse(rooms);
});

const handleCreate = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, stepId } = await params;
  const step = await loadBreakoutStep(id, stepId);
  if (!step) throw new NotFoundError('Breakout not found');

  const body = await validateRequestBody(request, createSchema);
  const ordinal = await prisma.appExperienceBreakoutRoom.count({ where: { stepId } });

  try {
    const room = await prisma.appExperienceBreakoutRoom.create({
      data: {
        stepId,
        name: body.name,
        mode: body.mode ?? 'individual',
        questionnaireId: body.questionnaireId ?? null,
        versionId: body.versionId ?? null,
        ordinal,
      },
    });
    log.info('Breakout room created', { experienceId: id, stepId, roomId: room.id });
    return successResponse(room, undefined, { status: 201 });
  } catch (err) {
    // `@@unique([stepId, name])` is the arbiter. Two rooms called "Table 3" in one breakout would
    // be unusable the moment a facilitator says the name out loud.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errorResponse('A room with that name already exists in this breakout', {
        code: 'CONFLICT',
        status: 409,
      });
    }
    throw err;
  }
});

export const GET = handleList;
export const POST = handleCreate;
