/**
 * Reopen eligibility — DB read seam (F-early-finish-reopen).
 *
 * The impure counterpart to the pure {@link isReopenEligible}: three reads keyed on
 * `sessionId` — current status + the version's LIVE `allowEarlyFinish`, experience-leg
 * membership (reused from the report enqueue module, not duplicated), and the `reason`
 * on the most recent `completed`-type session event. Consumed by both the status route
 * (`session-status.ts`, to project `reopenAvailable`) and the lifecycle route (to gate
 * the `reopen` action itself before calling `reopenSession`).
 */

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum } from '@/lib/app/questionnaire/types';
import { isReopenEligible } from '@/lib/app/questionnaire/session/reopen-logic';
import { isExperienceLeg } from '@/lib/app/questionnaire/report/enqueue';

/** Whether `sessionId` may reopen from `completed` back to `active` right now. `false` if the session doesn't exist. */
export async function resolveReopenEligibility(sessionId: string): Promise<boolean> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      version: { select: { config: { select: { allowEarlyFinish: true } } } },
    },
  });
  if (!row) return false;

  const [leg, latestCompleted] = await Promise.all([
    isExperienceLeg(sessionId),
    prisma.appQuestionnaireSessionEvent.findFirst({
      where: { sessionId, eventType: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { reason: true },
    }),
  ]);

  return isReopenEligible({
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    allowEarlyFinish: row.version?.config?.allowEarlyFinish ?? false,
    isExperienceLeg: leg,
    latestCompletedReason: latestCompleted?.reason ?? null,
  });
}
