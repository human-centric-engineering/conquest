/**
 * Join a live meeting (P15.5) — the participant's entry point.
 *
 * POST /api/v1/app/experiences/meetings/:meetingId/join
 *
 * Deliberately NOT admin-gated: a facilitated meeting is commonly a walk-up on a public link, and
 * access is decided by the experience's `accessMode` exactly as it is for a walk-up questionnaire.
 * An authenticated participant is recognised and rejoins their own run; an anonymous one gets a
 * signed session token for the leg, as the no-login questionnaire surface does.
 *
 * Refuses a meeting that has not started with a distinct code, so someone arriving early is told
 * "not started yet" rather than a generic failure — they are in the right place, just early.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getServerSession } from '@/lib/auth/utils';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { joinMeeting } from '@/app/api/v1/app/experiences/_lib/meeting-service';
import { experienceStartLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { meetingId } = await params;

  const session = await getServerSession();
  const respondentUserId = session?.user?.id ?? null;

  // Same posture as starting a run: keyed on the respondent where there is one, the IP otherwise,
  // so one signed-in participant cannot exhaust a shared office IP's quota for the whole room.
  const limitKey = respondentUserId ? `user:${respondentUserId}` : `ip:${getClientIP(request)}`;
  const limit = experienceStartLimiter.check(limitKey);
  if (!limit.success) return createRateLimitResponse(limit);

  const result = await joinMeeting({ meetingId, respondentUserId });

  if ('error' in result) {
    if (result.error === 'NOT_FOUND') {
      return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });
    }
    return errorResponse('This meeting has not started yet.', {
      code: 'MEETING_NOT_LIVE',
      status: 409,
    });
  }

  // The no-login surface drives its turns with a signed token, exactly as the anonymous
  // questionnaire surface does. An authenticated participant uses their cookie and ignores this.
  const token =
    !respondentUserId && result.sessionId ? mintSessionToken(result.sessionId).token : null;

  log.info('Meeting joined', { meetingId, runId: result.runId, hasSession: !!result.sessionId });
  return successResponse(
    {
      runId: result.runId,
      meetingId: result.meetingId,
      sessionId: result.sessionId,
      ...(token ? { sessionToken: token } : {}),
    },
    undefined,
    { status: 201 }
  );
}
