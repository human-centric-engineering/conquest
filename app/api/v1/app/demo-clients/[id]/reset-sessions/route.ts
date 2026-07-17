/**
 * DEMO-ONLY (F6.4): demo session reset.
 *
 * POST /api/v1/app/demo-clients/:id/reset-sessions — the between-demos "clean slate".
 * Hard-deletes the session graph (sessions + answer slots + turns + events) for every
 * version of every questionnaire attributed to this client, so the next prospect starts
 * fresh. Optional `?resetInvitations=true` also clears stale invitations (preserving
 * `started | completed | revoked`). Destructive; returns `deletedCounts`; audited as
 * `app_demo_client.reset_sessions` (the audit row is never deleted).
 *
 * Gate order: flag-gate first (404 when off), then `withAdminAuth` (401/403), then 404
 * on unknown id, then the 409 anonymousMode refusal (a structural block — wins over a
 * correct slug), then the 400 typed-confirmation (`confirmSlug` must equal the slug).
 *
 * "403 on ownership" is the admin-role guard: `AppDemoClient` has no per-user owner — it
 * is a global admin fixture, so `withAdminAuth` is the whole ownership story.
 *
 * A real client engagement strips this surface — see forking.md § "Replacing demo tenancy".
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import {
  resetSessionsSchema,
  resetSessionsQuerySchema,
} from '@/lib/app/questionnaire/demo-clients';
import { loadResetTargets, performReset } from '@/app/api/v1/app/demo-clients/_lib/reset';

const handleResetSessions = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const client = await prisma.appDemoClient.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true },
  });
  if (!client) {
    throw new NotFoundError('Demo client not found');
  }

  const { resetInvitations } = validateQueryParams(
    new URL(request.url).searchParams,
    resetSessionsQuerySchema
  );
  const body = await validateRequestBody(request, resetSessionsSchema);

  const { versionIds, anyAnonymous } = await loadResetTargets(id);

  // 409 refusal (F6.4) — too destructive for research-sensitive data. A structural
  // block: it wins over the typed confirmation, so a correct slug is still refused here.
  if (anyAnonymous) {
    return errorResponse(
      'Cannot reset sessions while a questionnaire for this client uses anonymous mode',
      { code: 'ANONYMOUS_MODE_PROTECTED', status: 409 }
    );
  }

  // 400 typed-confirmation — the value must equal the client's own slug.
  if (body.confirmSlug !== client.slug) {
    return errorResponse('Confirmation slug does not match the client slug', {
      code: 'CONFIRM_SLUG_MISMATCH',
      status: 400,
      details: { confirmSlug: ['Must equal the client slug'] },
    });
  }

  const deletedCounts = await performReset(versionIds, { resetInvitations });

  logAdminAction({
    userId: session.user.id,
    action: 'app_demo_client.reset_sessions',
    entityType: 'app_demo_client',
    entityId: id,
    entityName: client.name,
    metadata: { slug: client.slug, resetInvitations, deletedCounts },
    clientIp,
  });
  log.info('Demo client sessions reset', { id, resetInvitations, deletedCounts });

  return successResponse({ id, deletedCounts, resetInvitations });
});

export const POST = handleResetSessions;
