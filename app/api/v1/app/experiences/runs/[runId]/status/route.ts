/**
 * Experience run status (P15.2) — THE POLL ENDPOINT.
 *
 * GET /api/v1/app/experiences/runs/:runId/status?sessionId=<the leg the client knows about>
 *
 * The respondent's client polls this after submitting a leg, until it learns whether the journey
 * continues (`leg`) or is over (`conclude`).
 *
 * ## Two properties this endpoint must never lose
 *
 * **It must stay cheap.** Two indexed reads, no LLM call, no writes. A facilitated room of forty
 * people polling every 1.5s is real load, and P15.5's facilitator console reuses this primitive.
 *
 * **It must never trigger work.** A poll that could cause an advance would let a page refresh
 * double-fire the handoff. The advance is owned by the submit route's `after()` hook and by the
 * explicit `/advance` endpoint — never by a read.
 *
 * Access: the caller must prove ownership of a session in the run, either by cookie (the
 * authenticated respondent) or by the signed `X-Session-Token` (the no-login surface). An admin
 * may read any run.
 */

import type { NextRequest } from 'next/server';

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { prisma } from '@/lib/db/client';
import { getServerSession } from '@/lib/auth/utils';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { buildRunPollState } from '@/app/api/v1/app/experiences/_lib/run-read';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { verifySessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

/**
 * Whether this caller may read this run.
 *
 * Ownership is proven against the run's LEGS, not the run row: the no-login surface holds a token
 * for a session, and the authenticated surface owns sessions — neither knows anything about a run
 * id directly. An admin bypasses.
 */
async function canReadRun(
  request: NextRequest,
  runId: string
): Promise<{ allowed: boolean; knownSessionId?: string }> {
  const legs = await prisma.appExperienceRunLeg.findMany({
    where: { runId },
    select: { sessionId: true },
  });
  if (legs.length === 0) return { allowed: false };
  const legSessionIds = new Set(legs.map((l) => l.sessionId));

  // No-login surface: a signed token for any session in this run.
  const token = request.headers.get('x-session-token');
  if (token) {
    const verified = verifySessionToken(token, new Date());
    if (verified.ok && legSessionIds.has(verified.sessionId)) {
      return { allowed: true, knownSessionId: verified.sessionId };
    }
  }

  const session = await getServerSession();
  if (!session?.user) return { allowed: false };
  if (session.user.role === 'admin') return { allowed: true };

  // Authenticated respondent: they must own at least one of the run's sessions.
  const owned = await prisma.appQuestionnaireSession.findFirst({
    where: { id: { in: [...legSessionIds] }, respondentUserId: session.user.id },
    select: { id: true },
  });
  return owned ? { allowed: true, knownSessionId: owned.id } : { allowed: false };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { runId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const access = await canReadRun(request, runId);
  if (!access.allowed) {
    // 404 rather than 403: a caller who cannot prove ownership should not learn that this run id
    // exists at all.
    return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
  }

  // The client tells us which leg it already knows about, so a newly-minted later leg is
  // recognised as the handoff resolving. Falls back to whatever ownership proved.
  const knownSessionId =
    new URL(request.url).searchParams.get('sessionId') ?? access.knownSessionId;

  const state = await buildRunPollState(runId, knownSessionId ?? undefined);
  if (!state) {
    return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
  }

  log.debug('Experience run polled', { runId, state: state.state });
  return successResponse(state);
}
