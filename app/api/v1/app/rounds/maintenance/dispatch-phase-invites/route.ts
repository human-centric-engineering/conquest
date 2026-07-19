/**
 * Auto-stagger maintenance hook — dispatch invitations for phases whose window has opened.
 *
 * POST /api/v1/app/rounds/maintenance/dispatch-phase-invites
 *   For every open round, generates + emails the invitations of each phase whose `opensAt` has
 *   passed (idempotent — a phase is effectively dispatched once). This is the app-owned seam that
 *   makes staggered sending automatic WITHOUT forking the platform maintenance tick: point a
 *   scheduled workflow (an `AiWorkflowSchedule` cron calling this URL) or an external cron at it, or
 *   call it manually. Returns the run summary.
 *
 * `withAdminAuth` — the scheduled caller presents admin credentials. Audited.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { dispatchDuePhaseInvitations } from '@/app/api/v1/app/rounds/_lib/invites';

const handleDispatch = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);

  const result = await dispatchDuePhaseInvitations(session.user.id);

  // Only record an audit entry when something actually went out — steady-state ticks are no-ops.
  if (result.phasesProcessed > 0 && (result.created > 0 || result.sent > 0)) {
    logAdminAction({
      userId: session.user.id,
      action: 'app_round.dispatch_phase_invitations',
      entityType: 'app_questionnaire_round',
      entityId: 'maintenance',
      entityName: 'Phase invite dispatch',
      metadata: { ...result },
      clientIp,
    });
  }
  log.info('Phase invite dispatch run', { ...result });

  return successResponse(result);
});

export const POST = handleDispatch;
