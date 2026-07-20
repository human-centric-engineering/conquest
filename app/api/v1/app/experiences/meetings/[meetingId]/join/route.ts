/**
 * Join a live meeting (P15.5) — the participant's entry point.
 *
 * POST /api/v1/app/experiences/meetings/:meetingId/join
 *
 * Deliberately NOT admin-gated: a facilitated meeting is commonly a walk-up on a public link.
 * An authenticated participant is recognised and rejoins their own run; an anonymous one gets a
 * signed session token for the leg, as the no-login questionnaire surface does.
 *
 * Access is gated on the experience, not on the join code — the code goes on a slide and is read
 * aloud, so it is quotable, not secret. `joinMeeting` refuses a meeting whose experience is not
 * launched, and under `invitation_only` refuses an ANONYMOUS join while still admitting a signed-in
 * participant (the meeting path has no way to prove cohort membership, and refusing everyone would
 * make an invitation_only meeting unjoinable).
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
import { mintRunToken, runCookieHeader } from '@/app/api/v1/app/experiences/_lib/run-access-token';

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
    // A meeting on a draft or archived experience is an authoring slip. 404 rather than an
    // explanation: someone holding the code should not learn that an unlaunched experience exists.
    if (result.error === 'EXPERIENCE_NOT_RUNNING') {
      return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });
    }
    // The join code is quotable by design, so it cannot itself satisfy `invitation_only`. 403 with
    // a real reason: the participant is in the right place and needs to sign in, not go away.
    if (result.error === 'INVITATION_REQUIRED') {
      return errorResponse('Sign in to join this meeting.', {
        code: 'INVITATION_REQUIRED',
        status: 403,
      });
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
  const response = successResponse(
    {
      runId: result.runId,
      meetingId: result.meetingId,
      sessionId: result.sessionId,
      ...(token ? { sessionToken: token } : {}),
    },
    undefined,
    { status: 201 }
  );

  // The run credential (P15.3) — and on the meeting path it is not an optimisation, it is the only
  // proof of membership that exists. A participant joins during the facilitator's introduction,
  // before any breakout: their run has NO legs yet, so there is no session to hold a token for and
  // nothing for `canReadRun` to match a signed-in respondent against. `runId` cannot stand in — it
  // is a plain cuid that travels in query strings and logs, so treating it as a bearer token would
  // hand anyone who saw one a stranger's breakout session.
  //
  // Set for authenticated participants too, unlike `/x`, for exactly that reason: their own auth
  // cookie proves who they are but says nothing about a legless run.
  if (result.publicRef) {
    const { token: runToken } = mintRunToken(result.runId);
    response.headers.append('Set-Cookie', runCookieHeader(result.publicRef, runToken));
  }

  return response;
}
