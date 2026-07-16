/**
 * Cross-device session resume by support reference.
 *
 * POST /api/v1/app/questionnaire-sessions/resume-by-ref
 *   body: { ref: string }  →  { session: { id, versionId }, accessToken, expiresAt, ref }
 *
 * The public "I have my code, continue on this device" surface: a no-login respondent who kept
 * their support reference (`publicRef`, e.g. `7F3K-9M2P`) resumes an in-progress anonymous session
 * from any device — even after their client-held token expired. On a match we re-mint a fresh signed
 * `accessToken` (the same credential the `/anonymous` path issues) so the client can replay the
 * transcript and carry on. No `withAuth` — deliberately unauthenticated, gated by the live-sessions
 * flag and hard rate-limited.
 *
 * SECURITY (review-worthy — a new unauthenticated mutation surface): the ref is a low-entropy 8-char
 * code used as a bearer credential, so the resolve applies a strict guard set (anonymous +
 * non-preview + in-progress + the version opted in — see {@link resolveAnonymousResumeByRef}) and
 * every failure collapses to ONE generic 404 so the endpoint is not an enumeration oracle. The tight
 * IP rate limit throttles brute force. No new session is created and no answer content is returned —
 * only a token bound to the existing session id.
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resumeByRefLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { resolveAnonymousResumeByRef } from '@/app/api/v1/app/questionnaire-sessions/_lib/resume-by-ref';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

// A support ref is 8 Crockford chars; accept a generous bound so a dash/space/lower-case slip still
// reaches the forgiving normaliser rather than being rejected at the schema.
const bodySchema = z.object({ ref: z.string().trim().min(1).max(32) });

/** One message for every non-match — never reveal which guard failed (no enumeration oracle). */
const GENERIC_NOT_FOUND = 'No in-progress session was found for that reference.';

async function handleResumeByRef(request: NextRequest): Promise<Response> {
  try {
    const log = await getRouteLogger(request);

    // No user to key on — hard cap on client IP to throttle ref enumeration.
    const ip = getClientIP(request);
    const limit = resumeByRefLimiter.check(`resume-by-ref:${ip}`);
    if (!limit.success) return createRateLimitResponse(limit);

    const body = await validateRequestBody(request, bodySchema);
    const target = await resolveAnonymousResumeByRef(body.ref);

    if (!target) {
      // Deliberately generic: a bad code, a terminal/preview/authed session, and a resume-disabled
      // version all look identical to the caller.
      log.info('Resume-by-ref miss', { ip });
      return errorResponse(GENERIC_NOT_FOUND, { code: 'NO_RESUMABLE_SESSION', status: 404 });
    }

    const { token, expiresAt } = mintSessionToken(target.sessionId);
    log.info('Resume-by-ref matched', {
      sessionId: target.sessionId,
      versionId: target.versionId,
      status: target.status,
    });

    return successResponse({
      session: { id: target.sessionId, versionId: target.versionId },
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      ref: target.ref,
    });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = withLiveSessionsEnabled(handleResumeByRef);
