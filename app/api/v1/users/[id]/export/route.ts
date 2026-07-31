/**
 * Subject Access Export — admin
 *
 * GET /api/v1/users/:id/export - Export another user's data (admin only)
 *
 * The path an operator uses to answer a subject access request that arrives by
 * email or post rather than through the account itself. Mirrors
 * `DELETE /api/v1/users/:id` on the erasure side.
 *
 * Authentication: Admin role required.
 */

import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { userIdSchema } from '@/lib/validations/user';
import { exportUserData, SubjectNotFoundError } from '@/lib/privacy/export-user';
import { getRouteLogger } from '@/lib/api/context';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

/**
 * GET /api/v1/users/:id/export
 *
 * Returns the same bundle as the self-service route, for the named subject.
 * Admins deliberately have no filter over what it contains: an access response
 * an operator can narrow is one they can narrow by mistake.
 *
 * The request is logged with both the subject and the acting admin, since
 * reading someone else's record is itself an event worth being able to account
 * for later.
 *
 * @param params - Route parameters containing the subject's user ID
 * @returns The subject export bundle
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not an admin
 * @throws NotFoundError if no such user
 * @throws ValidationError if the ID format is invalid
 */
export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  // Await params (Next.js 16 requirement)
  const { id: userId } = await params;
  const { id } = validateQueryParams(new URLSearchParams({ id: userId }), userIdSchema);

  // Per-flow sub-cap on top of the section tier, keyed on the acting admin so
  // one operator working through a backlog can't be blocked by another.
  const rl = exportLimiter.check(`export:user:${session.user.id}`);
  if (!rl.success) return createRateLimitResponse(rl);

  const log = await getRouteLogger(request);
  log.info('Generating admin subject data export', { subjectUserId: id });

  try {
    const bundle = await exportUserData({
      userId: id,
      actorUserId: session.user.id,
      reason: 'admin_action',
    });

    return successResponse(bundle, undefined, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="subject-data-${id}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof SubjectNotFoundError) {
      throw new NotFoundError('User not found');
    }
    throw error;
  }
});
