/**
 * Route-local launch-blocker counter (F3.2) — the DB-touching half of the
 * launch-blocker seam whose pure half (the {@link LaunchBlockers} shape +
 * {@link hasLaunchBlockers} predicate) lives in
 * `lib/app/questionnaire/authoring/launch-blockers.ts`.
 *
 * A launched version is "pinned" by any live invitation (and, from P4, any open
 * session). Counting needs Prisma, which the `lib/app/questionnaire/**` boundary
 * forbids — so it lives here, alongside `fork.ts`, and the two callers (the fork
 * writer and the status route) import the counter from here while still taking the
 * pure predicate/type from `lib/app`.
 *
 * Re-exports `hasLaunchBlockers` + `LaunchBlockers` so a caller needs a single import.
 */

import { prisma } from '@/lib/db/client';
import {
  hasLaunchBlockers,
  type LaunchBlockers,
} from '@/lib/app/questionnaire/authoring/launch-blockers';
import { INVITATION_BLOCKER_STATUSES } from '@/lib/app/questionnaire/invitations';

export { hasLaunchBlockers, type LaunchBlockers };

/**
 * Count the live blockers pinning a launched version. Invitations are real as of
 * F3.2 (any non-revoked, non-terminal invitation pins the version); sessions slot
 * in here at P4 (zero until then) with no change to callers.
 */
export async function countLaunchBlockers(versionId: string): Promise<LaunchBlockers> {
  const invitations = await prisma.appQuestionnaireInvitation.count({
    where: { versionId, status: { in: [...INVITATION_BLOCKER_STATUSES] } },
  });
  return { invitations, sessions: 0 };
}
