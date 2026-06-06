/**
 * Turn-route access resolution (F6.1, PR6).
 *
 * The turn route serves two respondent kinds, so it can't use `withAuth` (which hard-
 * requires a session). This resolver branches on the session's `respondentUserId`:
 *
 *  - **Authenticated** (`respondentUserId` set) — require a logged-in session whose user
 *    matches; rate-key on the user id.
 *  - **Anonymous** (`respondentUserId` null) — require a valid `X-Session-Token` (the signed
 *    token the no-login create minted) bound to THIS session; rate-key on client IP +
 *    session id, since there's no user to key on.
 *
 * Returns the effective `userId` the invokers attribute spend to (`anon:<sessionId>` for the
 * no-login path) and the rate-limit key, or a typed failure the route maps to 401/403.
 */

import { headers } from 'next/headers';
import type { NextRequest } from 'next/server';

import { auth } from '@/lib/auth/config';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { getClientIP } from '@/lib/security/ip';
import { verifySessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

/** The header the no-login client presents its signed session token in. */
export const SESSION_TOKEN_HEADER = 'x-session-token';

export type TurnAccess =
  | { ok: true; userId: string; rateKey: string; anonymous: boolean }
  | { ok: false; status: number; code: string; message: string };

export async function resolveTurnAccess(
  request: NextRequest,
  session: { id: string; respondentUserId: string | null }
): Promise<TurnAccess> {
  // Authenticated session: a logged-in user who owns it. Mirror `withAuth` — accept a valid
  // API key (`Authorization: Bearer sk_...`) as well as a cookie session, so a headless
  // owner can drive their own session.
  if (session.respondentUserId !== null) {
    const apiKey = await resolveApiKey(request);
    const authSession =
      apiKey?.session ?? (await auth.api.getSession({ headers: await headers() }));
    if (!authSession) {
      return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Authentication required' };
    }
    if (authSession.user.id !== session.respondentUserId) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: 'You do not have access to this session',
      };
    }
    return {
      ok: true,
      userId: authSession.user.id,
      rateKey: authSession.user.id,
      anonymous: false,
    };
  }

  // Anonymous (no-login) session: a valid signed token bound to this session.
  const token = request.headers.get(SESSION_TOKEN_HEADER);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'SESSION_TOKEN_REQUIRED',
      message: 'A session token is required',
    };
  }
  const verified = verifySessionToken(token);
  if (!verified.ok || verified.sessionId !== session.id) {
    return {
      ok: false,
      status: 401,
      code: 'SESSION_TOKEN_INVALID',
      message: 'Invalid or expired session token',
    };
  }
  return {
    ok: true,
    userId: `anon:${session.id}`,
    rateKey: `anon:${getClientIP(request)}:${session.id}`,
    anonymous: true,
  };
}
