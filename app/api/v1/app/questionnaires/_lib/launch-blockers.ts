/**
 * Route-local launch-blocker counter (F3.2) — the DB-touching half of the
 * launch-blocker seam whose pure half (the {@link LaunchBlockers} shape +
 * {@link hasLaunchBlockers} predicate) lives in
 * `lib/app/questionnaire/authoring/launch-blockers.ts`.
 *
 * A launched version is "pinned" by any live invitation or any real respondent
 * session. Counting needs Prisma, which the `lib/app/questionnaire/**` boundary
 * forbids — so it lives here, alongside `fork.ts`, and the callers (the fork
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
 * Count the live blockers pinning a launched version:
 *   - invitations — any non-revoked, non-terminal invitation (F3.2).
 *   - sessions — any real respondent session (`isPreview: false`), regardless of
 *     status. A version any respondent has touched must not be mutated in place:
 *     its questions are pinned to that session's answers, so an edit forks a fresh
 *     draft instead. Admin **preview** sessions (`isPreview: true`) are the admin's
 *     own throwaway run and never pin — those edit in place.
 */
export async function countLaunchBlockers(versionId: string): Promise<LaunchBlockers> {
  const [invitations, sessions] = await Promise.all([
    prisma.appQuestionnaireInvitation.count({
      where: { versionId, status: { in: [...INVITATION_BLOCKER_STATUSES] } },
    }),
    prisma.appQuestionnaireSession.count({ where: { versionId, isPreview: false } }),
  ]);
  return { invitations, sessions };
}
