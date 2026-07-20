/**
 * Experience runs (P15.2) — collection endpoint.
 *
 * GET  /api/v1/app/experiences/:id/runs   — admin list of this experience's runs, newest-first.
 * POST /api/v1/app/experiences/:id/runs   — START a run. The respondent-facing entry point.
 *
 * The POST is deliberately NOT `withAdminAuth`: a public experience must be startable by an
 * unauthenticated walk-up, exactly as `/questionnaire-sessions/anonymous` is. Access is decided
 * inside `createExperienceRun` from the experience's `accessMode`, and the start sub-cap
 * (`experienceStartLimiter`) is applied first because this endpoint mints two rows per call.
 */

import type { NextRequest } from 'next/server';

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getServerSession } from '@/lib/auth/utils';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { z } from 'zod';

import { createExperienceRun } from '@/app/api/v1/app/experiences/_lib/run-create';
import { listRunsForExperience } from '@/app/api/v1/app/experiences/_lib/run-read';
import { experienceStartLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { mintRunToken, runCookieHeader } from '@/app/api/v1/app/experiences/_lib/run-access-token';

const startSchema = z.object({
  /** Optional cohort-member binding, when the caller arrived through a roster link. */
  cohortMemberId: z.string().min(1).max(64).optional(),
});

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const runs = await listRunsForExperience(id);
  log.info('Experience runs listed', { experienceId: id, count: runs.length });
  return successResponse(runs);
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const session = await getServerSession();
  const respondentUserId = session?.user?.id ?? null;

  // Keyed on the respondent where there is one, the IP otherwise — the same posture as
  // `sessionStartLimiter`, so one authenticated user cannot exhaust a shared office IP's quota.
  const limitKey = respondentUserId ? `user:${respondentUserId}` : `ip:${getClientIP(request)}`;
  const limit = experienceStartLimiter.check(limitKey);
  if (!limit.success) return createRateLimitResponse(limit);

  const body = await validateRequestBody(request, startSchema);

  const result = await createExperienceRun({
    experienceId: id,
    respondentUserId,
    cohortMemberId: body.cohortMemberId ?? null,
    // An authenticated user still passes through the accessMode gate: being logged in is not the
    // same as being invited, and an `invitation_only` experience must stay closed to a walk-up
    // account. Admins are handled by the preview path, not here.
    accessAlreadyProven: false,
  });

  if (!result.ok) {
    log.info('Experience run start rejected', { experienceId: id, code: result.code });
    return errorResponse(result.message, { code: result.code, status: result.status });
  }

  // The no-login surface drives its turns with a signed token, exactly as the anonymous
  // questionnaire surface does. An authenticated respondent uses their cookie and ignores this.
  const token = respondentUserId ? null : mintSessionToken(result.session.id);

  log.info('Experience run started', {
    experienceId: id,
    runId: result.run.id,
    sessionId: result.session.id,
  });

  const response = successResponse(
    {
      runId: result.run.id,
      publicRef: result.run.publicRef,
      sessionId: result.session.id,
      versionId: result.session.versionId,
      stepKey: result.stepKey,
      ...(token ? { sessionToken: token } : {}),
    },
    undefined,
    { status: 201 }
  );

  // The run credential (P15.3): an httpOnly cookie covering EVERY leg this run will ever have,
  // including ones that do not exist yet. It is what lets `/x/<publicRef>` open leg B on the
  // no-login surface without putting a credential in the URL — see `run-access-token.ts` for why
  // that distinction matters for this data in particular.
  //
  // Set for the no-login surface only. An authenticated respondent's own session cookie already
  // proves who they are, and issuing a second credential nobody needs widens the surface for
  // nothing. Skipped when the run has no publicRef (a pre-column row) — the cookie is keyed on it.
  if (!respondentUserId && result.run.publicRef) {
    const { token: runToken } = mintRunToken(result.run.id);
    response.headers.append('Set-Cookie', runCookieHeader(result.run.publicRef, runToken));
  }

  return response;
}

export const GET = handleList;
