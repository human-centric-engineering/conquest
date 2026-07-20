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

  const state = await participantState({ meetingId, runId });
  // 404 rather than 403: holding a run id you were not given should not confirm it exists.
  if (!state) return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });

  // A newly-minted session needs a credential on the no-login surface, exactly as the run-status
  // poll mints one for a newly-revealed leg.
  const session = await getServerSession();
  const token = !session?.user && state.sessionId ? mintSessionToken(state.sessionId).token : null;

  log.debug('Meeting participant polled', { meetingId, runId, canAnswer: state.window.canAnswer });
  return successResponse({
    sessionId: state.sessionId,
    window: state.window,
    ...(token ? { sessionToken: token } : {}),
  });
}
