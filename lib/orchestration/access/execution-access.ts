/**
 * Workflow-execution access authorization
 *
 * Single source of truth for "can this admin see this execution?". Every
 * execution route — list, detail, status, live, lease, report, review,
 * approve/reject/cancel, force-fail, retry-step, rerun, counts, and the
 * live-engine snapshot — gates through this module rather than comparing
 * `execution.userId` to the session id inline.
 *
 * Two bases:
 *
 *   1. `'owner'`  — the caller started the run (`userId === adminUserId`).
 *   2. `'system'` — nobody started it: schedule- and inbound-triggered runs
 *                   carry `userId = null` because the work is the
 *                   organisation's, not a person's (#502). Any admin may see
 *                   and act on them.
 *
 * **Why `'system'` exists.** Before #502 these rows were stamped with the
 * operator who configured the schedule or trigger, which made a third party's
 * inbound SMS look like that operator's personal data — erasing them
 * cascade-deleted the correspondence, and a subject-access export disclosed
 * it. Nulling the column fixes both, but a null owner matches no admin, so
 * without this basis every scheduled and inbound run would vanish from the
 * admin UI: invisible in the list, un-cancellable, and — for a run paused at
 * an approval gate — permanently stuck, since no one could approve it.
 *
 * The widening is deliberate and bounded. All callers are already behind
 * `withAdminAuth`, and a system-owned run has no data subject to shield it
 * from: it belongs to the deployment. It is NOT a general cross-user grant —
 * one admin still cannot see another admin's own runs.
 *
 * @see lib/orchestration/access/conversation-access.ts — same model for
 *      conversations, where the third basis is `'shared'`
 * @see .context/privacy/data-erasure.md — why these rows are system-owned
 */

import type { Prisma } from '@prisma/client';

/** Why an admin may see an execution. */
export type ExecutionAccessBasis = 'owner' | 'system';

/** The subset of an execution row this module needs. */
export interface ExecutionOwner {
  userId: string | null;
}

/**
 * Why the admin may see this execution, or `null` when they may not.
 *
 * Callers that need to distinguish the two bases (e.g. to log an action
 * taken on a system-owned run) use this; callers that only need a yes/no
 * use {@link adminCanViewExecution}.
 */
export function executionAccessBasis(
  execution: ExecutionOwner | null | undefined,
  adminUserId: string
): ExecutionAccessBasis | null {
  if (!execution) return null;
  if (execution.userId === null) return 'system';
  if (execution.userId === adminUserId) return 'owner';
  return null;
}

/**
 * Whether the admin may see (and act on) an already-fetched execution row.
 *
 * Routes translate `false` to a 404 rather than a 403 — surfacing "this
 * execution exists but isn't yours" is an id-enumeration vector.
 */
export function adminCanViewExecution(
  execution: ExecutionOwner | null | undefined,
  adminUserId: string
): boolean {
  return executionAccessBasis(execution, adminUserId) !== null;
}

/**
 * Prisma `where` fragment selecting the executions this admin may see:
 * their own, plus every system-owned run.
 *
 * Compose with `AND` when adding filters, so a caller-supplied filter can't
 * flatten the visibility clause:
 *
 * ```ts
 * const where = { AND: [executionVisibilityWhere(session.user.id), ...filters] };
 * ```
 */
export function executionVisibilityWhere(
  adminUserId: string
): Prisma.AiWorkflowExecutionWhereInput {
  return { OR: [{ userId: adminUserId }, { userId: null }] };
}
