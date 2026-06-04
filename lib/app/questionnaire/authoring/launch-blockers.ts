/**
 * Launch-blocker seam for the version-fork lifecycle (F2.1 / PR2; wired live in F3.2).
 *
 * A version is "launched" once it is sent to real users. Editing a launched
 * version must NOT mutate it in place — it forks a fresh draft so in-flight work
 * (sessions, sent invitations) stays pinned to the version it started on. The
 * fork trigger is therefore: the version's `status === 'launched'` OR it has any
 * live blocker.
 *
 * This module is PURE (no Prisma / Next): it defines the {@link LaunchBlockers}
 * shape and the {@link hasLaunchBlockers} predicate. **Counting** the blockers
 * needs the DB, so it lives route-local in
 * `app/api/v1/app/questionnaires/_lib/launch-blockers.ts` (`countLaunchBlockers`),
 * keeping `lib/app/questionnaire/**` storage-agnostic. F3.2 made that counter real
 * for invitations; sessions (P4) slot in there next, with no change to callers.
 */

/** The live work that pins a launched version. */
export interface LaunchBlockers {
  /** In-progress questionnaire sessions on this version (P4). */
  sessions: number;
  /** Live (non-revoked, non-terminal) invitations referencing this version (F3.2). */
  invitations: number;
}

/** True when any blocker is live — a launched-or-pinned version must fork on edit. */
export function hasLaunchBlockers(blockers: LaunchBlockers): boolean {
  return blockers.sessions > 0 || blockers.invitations > 0;
}
