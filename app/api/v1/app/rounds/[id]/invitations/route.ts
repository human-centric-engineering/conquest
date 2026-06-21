/**
 * Generate per-member invitations for a round (the grant mechanism).
 *
 * POST /api/v1/app/rounds/:id/invitations
 *   Mints a server-trusted `AppQuestionnaireInvitation` per active cohort member × per
 *   questionnaire-version the round bundles, stamping the round + member onto each. The
 *   respondent's resulting session reads its round context from that invitation (never the
 *   client body), so round membership can't be forged. Idempotent — re-running tops up newly
 *   added members. Returns counts + the freshly-minted frictionless links.
 *
 *   Optional body `{ send: true }` also EMAILS each freshly-minted link (frictionless no-login
 *   URL) and flips it to `sent`; omitted/false mints copy/paste links without sending. For
 *   STAGGERED per-subgroup sending see `…/phases/:phaseId/send-invites`.
 *
 * Cohorts flag-gate first (404 when off), then `withAdminAuth`. Audited.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withCohortsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { generateRoundInvitations } from '@/app/api/v1/app/rounds/_lib/invites';

const handleGenerate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  // Optional `{ send }` flag — tolerate an absent/empty body (the panel posts none today).
  let send = false;
  try {
    const body: unknown = await request.json();
    send = !!(body && typeof body === 'object' && (body as { send?: unknown }).send === true);
  } catch {
    /* no body — generate copy/paste links only */
  }

  const result = await generateRoundInvitations(id, session.user.id, { send });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.generate_invitations',
    entityType: 'app_questionnaire_round',
    entityId: id,
    entityName: round.name,
    metadata: {
      created: result.created,
      skipped: result.skipped,
      sent: result.sent,
      activeMembers: result.activeMembers,
    },
    clientIp,
  });
  log.info('Round invitations generated', {
    id,
    created: result.created,
    skipped: result.skipped,
    sent: result.sent,
  });

  return successResponse(result, undefined, { status: 201 });
});

export const POST = withCohortsEnabled(handleGenerate);
