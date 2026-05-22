/**
 * API Route Auth Guards
 *
 * Higher-order functions that wrap API route handlers with authentication
 * and authorization checks. Eliminates duplicated session/role boilerplate
 * across route handlers.
 *
 * Usage:
 * ```typescript
 * // Admin-only route
 * export const GET = withAdminAuth(async (request, session) => {
 *   // session is guaranteed to be an authenticated admin
 *   return successResponse({ data: '...' });
 * });
 *
 * // Any authenticated user
 * export const GET = withAuth(async (request, session) => {
 *   return successResponse({ user: session.user });
 * });
 * ```
 *
 * Error handling is automatic — handlers don't need try/catch for auth
 * or unhandled errors. All errors are routed through handleAPIError.
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { UnauthorizedError, ForbiddenError, handleAPIError } from '@/lib/api/errors';
import {
  RATE_LIMIT_TIERS,
  createRateLimitResponse,
  type AdminRateLimitTier,
} from '@/lib/security/rate-limit';

/**
 * Session type from better-auth (matches AuthSession in utils.ts)
 */
export interface AuthSession {
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
    role?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

/**
 * Next.js route params context shape
 */
interface RouteContext<TParams = Record<string, string>> {
  params: Promise<TParams>;
}

/**
 * Wrap an API route handler with authentication.
 *
 * - Retrieves the session from better-auth
 * - Throws UnauthorizedError (401) if no session
 * - Passes the session to the handler
 * - Catches all errors via handleAPIError
 *
 * @example
 * ```typescript
 * // Simple authenticated route (no params)
 * export const GET = withAuth(async (request, session) => {
 *   const user = await prisma.user.findUnique({ where: { id: session.user.id } });
 *   return successResponse(user);
 * });
 *
 * // Route with dynamic params
 * export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
 *   const { id } = await params;
 *   return successResponse({ id });
 * });
 * ```
 */
export function withAuth(
  handler: (request: NextRequest, session: AuthSession) => Response | Promise<Response>
): (request: NextRequest) => Promise<Response>;

export function withAuth<TParams>(
  handler: (
    request: NextRequest,
    session: AuthSession,
    context: RouteContext<TParams>
  ) => Response | Promise<Response>
): (request: NextRequest, context: RouteContext<TParams>) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withAuth(handler: (...args: any[]) => Response | Promise<Response>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<Response> => {
    try {
      const requestHeaders = await headers();
      const session = await auth.api.getSession({ headers: requestHeaders });

      if (!session) {
        throw new UnauthorizedError();
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const [request, context] = args;
      if (context !== undefined) {
        return await handler(request, session, context);
      }
      return await handler(request, session);
    } catch (error) {
      return handleAPIError(error);
    }
  };
}

/**
 * Options for {@link withAdminAuth}.
 */
export interface AdminAuthOptions {
  /**
   * Which rate-limit tier to apply.
   *
   * - `'admin'` (default) — 30/min. Core admin sections: users, logs,
   *   invitations, feature flags, stats. Fail-safe default; new routes must
   *   opt into the looser tier explicitly.
   * - `'orchestration'` — 120/min. Admin/orchestration UI: agents,
   *   capabilities, workflows, knowledge, executions, etc.
   *
   * Sized via env vars `RATE_LIMIT_ADMIN` and `RATE_LIMIT_ORCH_ADMIN`.
   * Per-endpoint sub-limiters (chat stream, audio, image, invite, upload)
   * layer on top of the section tier inside the handler.
   */
  rateLimit?: AdminRateLimitTier;
}

/**
 * Wrap an API route handler with admin authentication and rate limiting.
 *
 * - Retrieves the session from better-auth
 * - Throws UnauthorizedError (401) if no session
 * - Throws ForbiddenError (403) if user role is not ADMIN
 * - Applies the section rate limit, keyed on user ID — returns 429 if exceeded
 * - Passes the session to the handler
 * - Catches all errors via handleAPIError
 *
 * Order matters: auth → role → rate-limit. We rate-limit by `session.user.id`
 * (not IP), so the session must be resolved first. Anonymous and non-admin
 * traffic doesn't touch the admin rate-limit buckets.
 *
 * @example
 * ```typescript
 * // Core admin route — uses default 'admin' tier (30/min)
 * export const GET = withAdminAuth(async (request, session) => {
 *   const stats = await getSystemStats();
 *   return successResponse(stats);
 * });
 *
 * // Orchestration admin route — opts into looser tier (120/min)
 * export const GET = withAdminAuth(
 *   async (request, session) => successResponse(await listAgents()),
 *   { rateLimit: 'orchestration' }
 * );
 *
 * // Admin route with dynamic params
 * export const DELETE = withAdminAuth<{ id: string }>(
 *   async (request, session, { params }) => {
 *     const { id } = await params;
 *     await prisma.user.delete({ where: { id } });
 *     return successResponse({ id, deleted: true });
 *   },
 *   { rateLimit: 'admin' }
 * );
 * ```
 */
export function withAdminAuth(
  handler: (request: NextRequest, session: AuthSession) => Response | Promise<Response>,
  options?: AdminAuthOptions
): (request: NextRequest) => Promise<Response>;

export function withAdminAuth<TParams>(
  handler: (
    request: NextRequest,
    session: AuthSession,
    context: RouteContext<TParams>
  ) => Response | Promise<Response>,
  options?: AdminAuthOptions
): (request: NextRequest, context: RouteContext<TParams>) => Promise<Response>;

export function withAdminAuth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Response | Promise<Response>,
  options: AdminAuthOptions = {}
) {
  const tier: AdminRateLimitTier = options.rateLimit ?? 'admin';
  const limiter = RATE_LIMIT_TIERS[tier];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<Response> => {
    try {
      const requestHeaders = await headers();
      const session = await auth.api.getSession({ headers: requestHeaders });

      if (!session) {
        throw new UnauthorizedError();
      }

      if (session.user.role !== 'ADMIN') {
        throw new ForbiddenError('Admin access required');
      }

      const rateLimitResult = limiter.check(`admin:${tier}:user:${session.user.id}`);
      if (!rateLimitResult.success) {
        return createRateLimitResponse(rateLimitResult);
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const [request, context] = args;
      if (context !== undefined) {
        return await handler(request, session, context);
      }
      return await handler(request, session);
    } catch (error) {
      return handleAPIError(error);
    }
  };
}
