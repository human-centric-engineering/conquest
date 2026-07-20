/**
 * Stitched transcript (P15.3) — the earlier legs of a run, replayed above the live one.
 *
 * GET /api/v1/app/experiences/runs/:runId/transcript?sessionId=<the leg being answered>
 *
 * This is what makes `stitched` look like one continuous conversation. It is a pure READ: no rows
 * are written, merged or rewritten, which is exactly why `linked` and `stitched` can share a
 * persistence shape and an experience can be switched between them mid-flight.
 *
 * ## Why this is the most sensitive route the feature adds
 *
 * It returns whole conversations rather than a one-word state, so the access rule matters far more
 * here than on the poll. It shares `canReadRun` with the status route rather than reimplementing
 * it — two routes enforcing the same rule separately is how the weaker one becomes the way in.
 *
 * Two further narrowings on top of that check:
 *
 *  - **The admin bypass does not apply.** An admin may poll any run's status, but reading a
 *    respondent's transcript is a different act with its own audited surface (the sessions console
 *    and the admin session viewer). Letting it happen here would put respondent conversations
 *    behind a respondent-shaped endpoint with no audit trail.
 *  - **Only legs strictly BEFORE the caller's own** are returned, enforced in
 *    `loadStitchedHistory` by ordinal — never the whole run. A caller holding a token for the
 *    entry leg gets nothing, which is correct: nothing precedes it.
 */

import type { NextRequest } from 'next/server';

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { canReadRun } from '@/app/api/v1/app/experiences/_lib/run-access';
import { loadStitchedHistory } from '@/app/api/v1/app/experiences/_lib/run-read';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { runId } = await params;

  const limit = runPollLimiter.check(getClientIP(request));
  if (!limit.success) return createRateLimitResponse(limit);

  const access = await canReadRun(request, runId);
  // 404 rather than 403 throughout: a caller who cannot prove ownership should not learn that this
  // run id exists at all.
  if (!access.allowed || access.isAdmin) {
    return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
  }

  // The caller names the leg they are answering. It must be the one their credential actually
  // proved — otherwise a respondent holding the entry leg's token could name a LATER leg and be
  // handed the legs in between, which on a merged-roster experience need not be their own.
  const requested = new URL(request.url).searchParams.get('sessionId');
  const sessionId = requested ?? access.knownSessionId;
  if (!sessionId || (requested !== null && requested !== access.knownSessionId)) {
    return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
  }

  const history = await loadStitchedHistory(runId, sessionId);
  log.debug('Stitched transcript read', { runId, segments: history.segments.length });
  return successResponse(history);
}
