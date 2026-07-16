/**
 * No-login anonymous session — create (F6.1, PR6).
 *
 * POST /api/v1/app/questionnaire-sessions/anonymous
 *   body: { versionId: string }
 *
 * The public pop-up/ad-hoc/demo surface: anyone (no account) can start a session for a
 * launched questionnaire whose config has `anonymousMode = true`. Creates a session with a
 * null `respondentUserId` and mints a signed `accessToken` the caller presents on each turn
 * (the `X-Session-Token` header). No `withAuth` — this is deliberately unauthenticated; it's
 * rate-limited on client IP and gated by the live-sessions flag + the questionnaire's
 * anonymousMode. (Security review: a new unauthenticated mutation surface.)
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

import { sessionStartLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { createAnonymousSession } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import type { NextRequest } from 'next/server';

const bodySchema = z.object({ versionId: z.string().min(1).max(64) });

async function handleAnonymousCreate(request: NextRequest): Promise<Response> {
  try {
    const log = await getRouteLogger(request);

    // No user to key on — cap on client IP.
    const ip = getClientIP(request);
    const limit = sessionStartLimiter.check(`anon:${ip}`);
    if (!limit.success) return createRateLimitResponse(limit);

    const body = await validateRequestBody(request, bodySchema);
    const result = await createAnonymousSession(body.versionId);

    if (!result.ok) {
      log.info('Anonymous session create rejected', {
        code: result.code,
        versionId: body.versionId,
      });
      return errorResponse(result.message, { code: result.code, status: result.status });
    }

    const { token, expiresAt } = mintSessionToken(result.session.id);
    log.info('Anonymous session created', {
      sessionId: result.session.id,
      versionId: result.session.versionId,
    });

    return successResponse(
      { session: result.session, accessToken: token, expiresAt: expiresAt.toISOString() },
      undefined,
      { status: 201 }
    );
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = handleAnonymousCreate;
