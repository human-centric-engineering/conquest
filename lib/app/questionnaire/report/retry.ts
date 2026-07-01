/**
 * Respondent Report retry — the respondent-facing "Check again" re-trigger.
 *
 * Resets a report that won't otherwise progress back to `queued` so the worker (kicked right after,
 * or the maintenance cron) picks it up again:
 *   - a `failed` row (generation errored) → re-queue for a fresh attempt;
 *   - an orphaned `processing` row whose lease has gone stale (worker crashed mid-generation).
 *
 * Deliberately a NO-OP for `ready` (nothing to retry) and for a fresh `queued`/`processing` row
 * (already in flight — a retry must never clobber an in-progress generation). The reset is a single
 * conditional `updateMany`, so it races safely against a concurrent worker claim: whichever lands
 * first wins and the other's predicate no longer matches. Mirrors the worker's claim idempotency
 * (`lib/app/questionnaire/report/worker.ts`).
 */

import { prisma } from '@/lib/db/client';
import { REPORT_LEASE_TTL_MS } from '@/lib/app/questionnaire/report/worker';

/** Outcome of a retry request. `requeued` = a row was actually reset to `queued`. */
export interface RespondentReportRetryResult {
  requeued: boolean;
}

/**
 * Re-queue a stuck (`failed` / orphaned-`processing`) respondent report for the given session.
 * Returns `{ requeued: false }` when there is nothing to retry (no row, already `ready`, or a fresh
 * in-flight row). Clears the prior `error` and lease so the next claim starts clean.
 */
export async function requestRespondentReportRetry(
  sessionId: string
): Promise<RespondentReportRetryResult> {
  const orphanCutoff = new Date(Date.now() - REPORT_LEASE_TTL_MS);

  const result = await prisma.appRespondentReport.updateMany({
    where: {
      sessionId,
      OR: [{ status: 'failed' }, { status: 'processing', lockedAt: { lt: orphanCutoff } }],
    },
    data: { status: 'queued', error: null, lockedBy: null, lockedAt: null },
  });

  return { requeued: result.count > 0 };
}
