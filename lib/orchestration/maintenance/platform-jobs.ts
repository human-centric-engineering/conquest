/**
 * Sunrise's own recurring maintenance tasks, with a minimum interval each.
 *
 * Before #442 all eight ran on **every** tick. At the documented 60s cadence
 * that meant the retention sweep (whose windows are measured in days) ran 1,440
 * times a day and the embedding backfill full-scanned the message table just as
 * often. On a scale-to-zero Postgres (Neon, Aurora Serverless v2) the compute
 * never idles, so a deployment with no traffic bills as if it ran flat out.
 *
 * Each task now declares the shortest gap at which running it can still find
 * work. The intervals below are derived from each task's own thresholds, not
 * picked for taste — see the table in
 * `.context/orchestration/scheduling.md`.
 *
 * ## Why not `registerAppJob`?
 *
 * The fork seam is keyed by name and documented as replace-on-re-register, so a
 * fork registering `retention` would silently disable Sunrise's own sweep. It
 * would also change what the already-shipped `getAppJobs()` returns. Platform
 * tasks therefore get their own table and their own clock.
 *
 * @see lib/orchestration/maintenance/run-tick.ts — the consumer
 * @see lib/orchestration/maintenance/job-clock.ts — the throttle mechanism
 * @see lib/orchestration/maintenance/app-jobs.ts — the fork-owned equivalent
 */

import { logger } from '@/lib/logging';
import { createJobClock } from '@/lib/orchestration/maintenance/job-clock';
import {
  processOrphanedExecutions,
  processPendingExecutions,
} from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';
import { processPendingEvaluationRuns } from '@/lib/orchestration/evaluations/run-worker';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A platform maintenance task and the shortest gap worth running it at. */
export interface PlatformJob {
  /** Stable name — appears in the tick's log line and in the route's `backgroundTasks`. */
  name: string;
  /** Minimum gap between starts, in ms. `0` means every tick. */
  intervalMs: number;
  /** The work. Its return value is folded into the tick's completion log line. */
  run: () => Promise<unknown>;
}

/**
 * Order is contract: the route publishes it as `backgroundTasks` and the
 * documented response shape lists it. Append, don't reorder.
 *
 * Intervals:
 *
 * | Task                      | Interval | Why                                                                |
 * | ------------------------- | -------- | ------------------------------------------------------------------ |
 * | `webhookRetries`          | every    | backoff starts at 10s — throttling would miss the first retry       |
 * | `hookRetries`             | every    | same 10s/60s/300s backoff                                          |
 * | `orphanSweep`             | 2 min    | lease is 3 min, so a faster sweep provably finds nothing            |
 * | `zombieReaper`            | 5 min    | its own stale threshold is 30 min                                   |
 * | `embeddingBackfill`       | 15 min   | best-effort re-embed of a failed write; unindexed anti-join         |
 * | `retention`               | 1 hour   | windows are measured in days                                        |
 * | `pendingExecutionRecovery`| 2 min    | its own stale-pending threshold is 2 min                            |
 * | `evaluationRuns`          | every    | the worker drives one time-slice per tick, so cadence is throughput |
 */
export const PLATFORM_JOBS = [
  { name: 'webhookRetries', intervalMs: 0, run: () => processPendingRetries() },
  { name: 'hookRetries', intervalMs: 0, run: () => processPendingHookRetries() },
  { name: 'orphanSweep', intervalMs: 2 * MINUTE, run: () => processOrphanedExecutions() },
  { name: 'zombieReaper', intervalMs: 5 * MINUTE, run: () => reapZombieExecutions() },
  { name: 'embeddingBackfill', intervalMs: 15 * MINUTE, run: () => backfillMissingEmbeddings() },
  { name: 'retention', intervalMs: HOUR, run: () => enforceRetentionPolicies() },
  {
    name: 'pendingExecutionRecovery',
    intervalMs: 2 * MINUTE,
    run: () => processPendingExecutions(),
  },
  { name: 'evaluationRuns', intervalMs: 0, run: () => processPendingEvaluationRuns() },
] as const satisfies readonly PlatformJob[];

export type PlatformJobName = (typeof PLATFORM_JOBS)[number]['name'];

/** Task names in table order. Re-exported by `run-tick.ts` as `BACKGROUND_TASK_NAMES`. */
export const PLATFORM_JOB_NAMES: readonly PlatformJobName[] = PLATFORM_JOBS.map((job) => job.name);

/** Value written to the tick log line for a task held back by its interval. */
export const THROTTLED = 'skipped';

const clock = createJobClock();

/** Test-only: clear the throttle state so each test starts with every task due. */
export function __resetPlatformJobsForTests(): void {
  clock.reset();
}

/**
 * Run every platform task whose interval has elapsed, in parallel.
 *
 * Never throws and never lets one task affect another — a rejection becomes
 * `{ error }` in the returned summary, which is what the tick's log line
 * reports. Tasks held back by their interval report `'skipped'` rather than
 * being omitted, so an operator can see the cadence working instead of
 * wondering whether the sweep ran.
 *
 * @param now Tick start time. Intervals measure start-to-start from this value.
 */
export async function runDuePlatformJobs(
  now: number = Date.now()
): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};

  const entries = await Promise.all(
    PLATFORM_JOBS.map(async (job) => {
      if (!clock.isDue(job.name, job.intervalMs, now)) {
        return [job.name, THROTTLED] as const;
      }
      clock.markStarted(job.name, now);
      try {
        return [job.name, await job.run()] as const;
      } catch (err) {
        // Contained here rather than in `run-tick.ts` so one failing sweep can
        // never take down the whole summary line.
        logger.error('maintenance task failed', {
          task: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return [job.name, { error: String(err) }] as const;
      } finally {
        clock.markSettled(job.name);
      }
    })
  );

  for (const [name, result] of entries) summary[name] = result;
  return summary;
}
