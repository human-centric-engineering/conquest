/**
 * Breakout rooms in a live meeting (P15.5b).
 *
 * GET  — the rooms of the CURRENT breakout, with live occupancy. Empty when the breakout has no
 *        rooms, which is the common case.
 * POST — choose a room. In a `scribe` room this also claims the pen when nobody holds it.
 *
 * Respondent-facing: participants pick their own room. Deliberately not admin-gated — a facilitator
 * saying "table three, use the third option" is faster than assigning forty people by hand.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { chooseRoom, loadBreakoutRooms } from '@/app/api/v1/app/experiences/_lib/meeting-service';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { getServerSession } from '@/lib/auth/utils';

const chooseSchema = z.object({
  runId: z.string().min(1),
  roomId: z.string().min(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
  const { meetingId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const meeting = await prisma.appExperienceMeeting.findUnique({
    where: { id: meetingId },
    select: { currentStepId: true },
  });
  if (!meeting) return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });
  if (!meeting.currentStepId) return successResponse({ rooms: [] });

  const rooms = await loadBreakoutRooms({ meetingId, stepId: meeting.currentStepId });
  return successResponse({ rooms });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { meetingId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const body = await validateRequestBody(request, chooseSchema);
  const result = await chooseRoom({ meetingId, runId: body.runId, roomId: body.roomId });

  if (!result.ok) {
    return errorResponse(result.message, {
      code: result.code,
      status: result.code === 'NOT_FOUND' ? 404 : 409,
    });
  }

  // A newly-minted session needs a credential on the no-login surface. Null in a scribe room where
  // somebody else holds the pen — they are in the room, watching, with nothing to drive.
  const session = await getServerSession();
  const token =
    !session?.user && result.sessionId ? mintSessionToken(result.sessionId).token : null;

  log.info('Meeting room chosen', { meetingId, roomId: body.roomId, writing: !!result.sessionId });
  return successResponse({
    sessionId: result.sessionId,
    ...(token ? { sessionToken: token } : {}),
  });
}
