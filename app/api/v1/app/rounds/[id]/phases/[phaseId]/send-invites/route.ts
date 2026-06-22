/**
 * Send a single phase's invitations — the staggered-send action.
 *
 * POST /api/v1/app/rounds/:id/phases/:phaseId/send-invites
 *   Generates (tops up) and EMAILS the frictionless invitations for just this phase's subgroup, so
 *   an admin can release one group (e.g. the leadership team) ahead of the rest. Idempotent: members
 *   already invited are skipped; only freshly-minted links are emailed. Returns the generation result.
 *
 * Round-phases flag-gate first (404 when off), then `withAdminAuth`. Audited.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withRoundPhasesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { generateRoundInvitations } from '@/app/api/v1/app/rounds/_lib/invites';

type Params = { id: string; phaseId: string };

const handleSend = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, phaseId } = await params;

  const phase = await prisma.appRoundPhase.findFirst({
    where: { id: phaseId, roundId: id },
    select: { id: true, subgroupId: true, round: { select: { name: true } } },
  });
  if (!phase) throw new NotFoundError('Round phase not found');

  const result = await generateRoundInvitations(id, session.user.id, {
    subgroupId: phase.subgroupId,
    send: true,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.send_phase_invitations',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: phase.round.name,
    metadata: {
      phaseId,
      subgroupId: phase.subgroupId,
      created: result.created,
      sent: result.sent,
      skipped: result.skipped,
    },
    clientIp,
  });
  log.info('Round phase invitations sent', {
    id,
    phaseId,
    created: result.created,
    sent: result.sent,
  });

  return successResponse(result, undefined, { status: 201 });
});

export const POST = withRoundPhasesEnabled(handleSend);
