/**
 * Invitation status-transition rules (F3.2). Pure — no Prisma / Next. The routes
 * map an illegal transition to a 4xx; this module only decides legality, so it is
 * unit-testable in isolation (the same split the version `status/route.ts` uses
 * inline, lifted here because the invitation lifecycle is richer).
 */

import type { AppInvitationStatus } from '@/lib/app/questionnaire/invitations/types';
import { INVITATION_RESENDABLE_STATUSES } from '@/lib/app/questionnaire/invitations/types';

/**
 * Legal forward transitions. `revoked`/`completed` are terminal. Self-loops are not
 * transitions (idempotent re-opens / re-sends are handled in the routes, not here).
 * `started`/`completed` edges exist for P6/P7 but no F3.2 route walks them.
 */
const INVITATION_TRANSITIONS: Record<AppInvitationStatus, readonly AppInvitationStatus[]> = {
  pending: ['sent', 'revoked'],
  sent: ['opened', 'registered', 'revoked'],
  opened: ['registered', 'revoked'],
  registered: ['started'], // P6/P7
  started: ['completed'], // P6/P7
  completed: [],
  revoked: [],
};

/** True when `from → to` is a legal lifecycle transition. */
export function isInvitationTransitionAllowed(
  from: AppInvitationStatus,
  to: AppInvitationStatus
): boolean {
  return INVITATION_TRANSITIONS[from].includes(to);
}

/** True when an invitation in this status can be re-sent (regenerating its token). */
export function isInvitationResendable(status: AppInvitationStatus): boolean {
  return (INVITATION_RESENDABLE_STATUSES as readonly AppInvitationStatus[]).includes(status);
}
