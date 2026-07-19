/**
 * Frictionless invite session — create (invitations Phase B).
 *
 * POST /api/v1/app/questionnaire-sessions/from-invite
 *   body: { inviteToken: string }
 *
 * A per-invitee token boots a NO-LOGIN session bound to the invitation (the token IS the
 * credential). Mirrors the anonymous route: null `respondentUserId`, a signed `accessToken` the
 * caller presents on each turn (`X-Session-Token`), so the existing anonymous turn path drives it
 * unchanged. Deliberately unauthenticated; rate-limited on client IP. (Security review: an
 * unauthenticated mutation surface keyed on a 32-byte token.)
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

import { sessionStartLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { createSessionFromInviteToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const bodySchema = z.object({ inviteToken: z.string().min(1).max(128) });

async function handleFromInvite(request: NextRequest): Promise<Response> {
  try {
    const log = await getRouteLogger(request);

    // No user to key on — cap on client IP (also a token brute-force guard).
    const ip = getClientIP(request);
    const limit = sessionStartLimiter.check(`invite:${ip}`);
    if (!limit.success) return createRateLimitResponse(limit);

    const body = await validateRequestBody(request, bodySchema);
    const result = await createSessionFromInviteToken(body.inviteToken);

    if (!result.ok) {
      log.info('Invite session create rejected', { code: result.code });
      return errorResponse(result.message, { code: result.code, status: result.status });
    }

    const { token, expiresAt } = mintSessionToken(result.session.id);
    log.info('Invite session created', {
      sessionId: result.session.id,
      versionId: result.session.versionId,
      resumed: result.resumed,
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

export const POST = handleFromInvite;
