/**
 * Meetings for an experience (P15.5).
 *
 * GET  — admin list of this experience's meetings, newest first.
 * POST — create one occurrence. Returns the join ref that goes on the slide.
 *
 * Both admin-only: a meeting is an authoring/operating act, not a respondent one. Participants
 * never touch this route — they arrive at `/m/<joinRef>`.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { createMeeting } from '@/app/api/v1/app/experiences/_lib/meeting-service';
import { EXPERIENCE_TITLE_MAX_LENGTH } from '@/lib/app/questionnaire/experiences/types';

type Params = { id: string };

const createSchema = z.object({
  /** Names this occurrence ("Q3 Planning — 14 Aug"). Null falls back to the experience title. */
  title: z.string().trim().max(EXPERIENCE_TITLE_MAX_LENGTH).nullable().optional(),
});

const handleList = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const meetings = await prisma.appExperienceMeeting.findMany({
    where: { experienceId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      joinRef: true,
      title: true,
      status: true,
      startedAt: true,
      endedAt: true,
      createdAt: true,
      _count: { select: { runs: true } },
    },
  });

  log.info('Experience meetings listed', { experienceId: id, count: meetings.length });
  return successResponse(
    meetings.map((m) => ({
      id: m.id,
      joinRef: m.joinRef,
      title: m.title,
      status: m.status,
      participantCount: m._count.runs,
      startedAt: m.startedAt?.toISOString() ?? null,
      endedAt: m.endedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    }))
  );
});

const handleCreate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  const body = await validateRequestBody(request, createSchema);

  const meeting = await createMeeting({
    experienceId: id,
    title: body.title ?? null,
    facilitatorUserId: session.user.id,
  });

  log.info('Experience meeting created', { experienceId: id, meetingId: meeting.id });
  return successResponse(meeting, undefined, { status: 201 });
});

export const GET = handleList;
export const POST = handleCreate;
