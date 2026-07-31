/**
 * Session revocation (#489).
 *
 * better-auth revokes sessions for a password change (`revokeOtherSessions` on
 * `changePassword`) but has no equivalent for an email change, and nothing in
 * this codebase deleted session rows at all. That gap is what turns a single
 * stolen session into a durable one: the address that owns the account can be
 * moved while every other logged-in device keeps its cookie.
 *
 * Deliberately a thin Prisma delete rather than a better-auth call: the
 * library's own revocation helpers are endpoint-scoped (they want a request
 * context we do not have inside a verification callback), whereas the `session`
 * table is a stable, documented part of the auth schema.
 *
 * @see lib/auth/config.ts · prisma/schema/auth.prisma · .context/auth/sessions.md
 */
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Delete a user's sessions, optionally sparing the one making the current
 * request — the same shape as better-auth's `revokeOtherSessions` on
 * `changePassword`.
 *
 * Pass `exceptSessionToken` to keep the caller signed in. Omit it (or pass
 * `null`) to revoke everything, which is the correct degradation when the
 * current session cannot be identified: signing the user out costs them one
 * login, whereas guessing wrong would leave an attacker's session alive.
 *
 * Returns the number of sessions removed so callers can log it.
 */
export async function revokeUserSessions({
  userId,
  exceptSessionToken,
  reason,
}: {
  userId: string;
  exceptSessionToken?: string | null;
  reason: string;
}): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      userId,
      ...(exceptSessionToken ? { token: { not: exceptSessionToken } } : {}),
    },
  });

  logger.info('Revoked user sessions', {
    userId,
    reason,
    revokedCount: count,
    keptCurrentSession: Boolean(exceptSessionToken),
  });

  return count;
}
