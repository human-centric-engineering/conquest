/**
 * Launch-blocker seam for the version-fork lifecycle (F2.1 / PR2).
 *
 * A version is "launched" once it is sent to real users. Editing a launched
 * version must NOT mutate it in place — it forks a fresh draft so in-flight work
 * (sessions, sent invitations) stays pinned to the version it started on. The
 * fork trigger is therefore: the version's `status === 'launched'` OR it has any
 * live blocker.
 *
 * Blockers — open sessions (P4) and sent invitations (P3) — don't exist yet, so
 * `countLaunchBlockers` returns zeros today. It is deliberately `async` and takes
 * the `versionId` so its signature is stable when P3/P4 wire in the real counts:
 * no caller (the fork writer) changes when this starts returning non-zero.
 *
 * Pure: no Prisma / Next imports. The DB-touching fork writer lives route-local
 * (`app/api/v1/app/questionnaires/_lib/fork.ts`), keeping `lib/app/questionnaire/**`
 * storage-agnostic.
 */

/** The live work that pins a launched version. Zero on every field until P3/P4. */
export interface LaunchBlockers {
  /** In-progress questionnaire sessions on this version (P4). */
  sessions: number;
  /** Sent (not-yet-revoked) invitations referencing this version (P3). */
  invitations: number;
}

/**
 * Count the live blockers on a version. Returns `{ sessions: 0, invitations: 0 }`
 * until P3 (invitations) and P4 (sessions) land their models — at which point the
 * real counts slot in here with no change to callers.
 */
export function countLaunchBlockers(_versionId: string): Promise<LaunchBlockers> {
  // P3/P4 seam: no session/invitation models exist yet, so nothing can block.
  // Returns a Promise (not `async`) so the signature is stable when P3/P4 wire in
  // real DB counts here without churning callers.
  return Promise.resolve({ sessions: 0, invitations: 0 });
}

/** True when any blocker is live — a launched-or-pinned version must fork on edit. */
export function hasLaunchBlockers(blockers: LaunchBlockers): boolean {
  return blockers.sessions > 0 || blockers.invitations > 0;
}
