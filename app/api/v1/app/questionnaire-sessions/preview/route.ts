/**
 * Admin "Preview as respondent" session — create.
 *
 * POST /api/v1/app/questionnaire-sessions/preview
 *   body: { versionId: string }
 *
 * Lets an admin walk a launched questionnaire as a respondent regardless of its
 * `anonymousMode` setting. Mirrors the no-login `/anonymous` route — creates a user-less
 * session and mints the same signed `accessToken` (presented on each turn via the
 * `X-Session-Token` header) — but it is `withAdminAuth` (not public) and the created session
 * is `isPreview: true`, so the walkthrough never counts in analytics. The anonymous-mode gate
 * that `/anonymous` enforces is deliberately absent here: previewing an invitation-gated
 * questionnaire is the whole point.
 *
 * Flag-gated by live-sessions first (404 when off), then admin auth.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { sessionStartLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { createPreviewSession } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const bodySchema = z.object({ versionId: z.string().min(1).max(64) });

const handlePreviewCreate = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  // Cheap write, but it mints a session + spins up the live surface — sub-cap per admin.
  const limit = sessionStartLimiter.check(`preview:${session.user.id}`);
  if (!limit.success) return createRateLimitResponse(limit);

  const body = await validateRequestBody(request, bodySchema);
  const result = await createPreviewSession(body.versionId);

  if (!result.ok) {
    log.info('Preview session create rejected', { code: result.code, versionId: body.versionId });
    return errorResponse(result.message, { code: result.code, status: result.status });
  }

  const { token, expiresAt } = mintSessionToken(result.session.id);
  log.info('Preview session created', {
    sessionId: result.session.id,
    versionId: result.session.versionId,
    adminUserId: session.user.id,
  });

  return successResponse(
    { session: result.session, accessToken: token, expiresAt: expiresAt.toISOString() },
    undefined,
    { status: 201 }
  );
});

export const POST = withLiveSessionsEnabled(handlePreviewCreate);
