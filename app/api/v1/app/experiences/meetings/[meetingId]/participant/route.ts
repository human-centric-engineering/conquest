/**
 * The participant's own live state (P15.5).
 *
 * GET /api/v1/app/experiences/meetings/:meetingId/participant?runId=…
 *
 * Answers the two questions a participant's surface asks continuously: which session am I
 * answering, and may I answer right now. The session is minted lazily here — most people join
 * before the first breakout runs, so their session does not exist until the facilitator starts one.
 *
 * `window` distinguishes answering from submitting, so the surface can keep a composer live during
 * the grace period for someone mid-sentence while refusing to start anything new.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { participantState } from '@/app/api/v1/app/experiences/_lib/meeting-service';
import { canReadRun } from '@/app/api/v1/app/experiences/_lib/run-access';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { getServerSession } from '@/lib/auth/utils';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { meetingId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId) return errorResponse('runId is required', { code: 'VALIDATION_ERROR', status: 400 });

  // `runId` addresses the run; it does NOT authorise it. It is a plain cuid that travels in this
  // very query string, in access logs, and in the `/join` response body — so it must be proven,
  // not merely presented. Without this the endpoint would mint a session token for whoever quoted
  // someone else's run id, handing them a stranger's breakout session. The credential to pass it
  // is set as an httpOnly cookie at `/join`, before any breakout exists.
  //
  // Checked BEFORE `participantState`, so an unproven caller cannot even provoke the lazy session
  // creation below.
  const access = await canReadRun(request, runId);
  // 404 rather than 403, and the same 404 an unknown meeting gets: holding a run id you were not
  // given should not confirm it exists.
  if (!access.allowed)
    return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });

  const state = await participantState({ meetingId, runId });
  if (!state) return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });

  // A newly-minted session needs a credential on the no-login surface, exactly as the run-status
  // poll mints one for a newly-revealed leg. Only ever for a caller who passed the gate above.
  const session = await getServerSession();
  const token = !session?.user && state.sessionId ? mintSessionToken(state.sessionId).token : null;

  log.debug('Meeting participant polled', { meetingId, runId, canAnswer: state.window.canAnswer });
  return successResponse({
    sessionId: state.sessionId,
    window: state.window,
    ...(token ? { sessionToken: token } : {}),
  });
}
