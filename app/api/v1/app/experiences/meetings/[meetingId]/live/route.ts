/**
 * The meeting live state (P15.5) — THE POLL ENDPOINT for both audiences.
 *
 * GET /api/v1/app/experiences/meetings/:meetingId/live
 *
 * Serves the facilitator console AND the participant surface from one shape, filtered server-side:
 * the facilitator gets every gated insight plus the withheld count, a participant gets only those
 * published to them. Two endpoints would drift on the field that matters most — which findings are
 * safe to show — so there is one, and the audience is decided here.
 *
 * Never triggers work: the same rule as the run-status poll. A synthesis is expensive and a poll
 * that could start one would let a room full of open tabs run it dozens of times over.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getServerSession } from '@/lib/auth/utils';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';

import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import {
  buildMeetingLiveState,
  loadMeetingInsights,
} from '@/app/api/v1/app/experiences/_lib/meeting-service';
import { verifySessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

/**
 * Who is asking.
 *
 * An admin is the facilitator. Anyone holding a session token for a leg of this meeting is a
 * participant. Nobody else gets anything — a meeting id is a cuid, but the live state names the
 * room's size and progress, which is not public information.
 */
async function resolveAudience(
  request: NextRequest,
  meetingId: string
): Promise<'facilitator' | 'respondent' | null> {
  const session = await getServerSession();
  if (session?.user?.role === 'ADMIN') return 'facilitator';

  const token = request.headers.get('x-session-token');
  if (token) {
    const verified = verifySessionToken(token, new Date());
    if (verified.ok) {
      const leg = await prisma.appExperienceRunLeg.findUnique({
        where: { sessionId: verified.sessionId },
        select: { run: { select: { meetingId: true } } },
      });
      if (leg?.run.meetingId === meetingId) return 'respondent';
    }
  }

  // An authenticated respondent who owns a session in this meeting.
  if (session?.user) {
    const owned = await prisma.appExperienceRun.findFirst({
      where: { meetingId, respondentUserId: session.user.id },
      select: { id: true },
    });
    if (owned) return 'respondent';
  }

  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { meetingId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const audience = await resolveAudience(request, meetingId);
  if (!audience) return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });

  const state = await buildMeetingLiveState(meetingId);
  if (!state) return errorResponse('Meeting not found', { code: 'NOT_FOUND', status: 404 });

  const { insights, withheld } = await loadMeetingInsights(meetingId, audience);

  log.debug('Meeting polled', { meetingId, audience, status: state.status });
  return successResponse({ ...state, audience, insights, withheld });
}
