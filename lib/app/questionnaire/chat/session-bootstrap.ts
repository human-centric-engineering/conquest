/**
 * Server-side session bootstrap for the authenticated respondent surface (F7.1).
 *
 * Wraps the F6.1 create/resume route (`POST /api/v1/app/questionnaire-sessions`) so the
 * `start` server component can mint or resume a session and branch cleanly on failure.
 * Cookie forwarding is handled by {@link serverFetch}; the create route's `withAuth` does
 * the rest. The no-login anonymous path is bootstrapped client-side instead (the token must
 * never be serialized into server-rendered HTML) — see `anonymous-session-boot.tsx`.
 *
 * Server-only.
 */

import { API } from '@/lib/api/endpoints';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

interface CreatedSession {
  id: string;
  status: string;
  versionId: string;
}

export type AuthedSessionBootstrap =
  { ok: true; sessionId: string; resumed: boolean } | { ok: false; code: string; message: string };

/** Arguments mirror the create route's union body: an invitation token OR a version id. */
export type AuthedSessionRequest = { invitationToken: string } | { versionId: string };

/**
 * Create (or resume) the caller's authenticated session for a questionnaire and return its
 * id, or a typed failure the page maps to a friendly screen. Never throws on a non-2xx.
 */
export async function createOrResumeAuthedSession(
  request: AuthedSessionRequest
): Promise<AuthedSessionBootstrap> {
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRE_SESSIONS.ROOT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    const body = await parseApiResponse<{ session: CreatedSession }>(res);
    if (!body.success) {
      return {
        ok: false,
        code: body.error.code ?? 'SESSION_CREATE_FAILED',
        message: body.error.message,
      };
    }

    const resumed =
      typeof body.meta === 'object' &&
      body.meta !== null &&
      'resumed' in body.meta &&
      Boolean((body.meta as { resumed?: unknown }).resumed);

    return { ok: true, sessionId: body.data.session.id, resumed };
  } catch (err) {
    logger.error('createOrResumeAuthedSession failed', err);
    return {
      ok: false,
      code: 'SESSION_CREATE_FAILED',
      message: 'We could not start your questionnaire. Please try again.',
    };
  }
}
