/**
 * Shared maintenance-tick body.
 *
 * Used by both:
 *   - `POST /api/v1/admin/orchestration/maintenance/tick` (external cron / manual)
 *   - `instrumentation.ts` (dev-only setInterval)
 *
 * Encapsulates the overlap guard, watchdog, schedule sweep, background
 * task chain, and per-task logging. Callers receive the schedules
 * result and a `skipped` flag so the HTTP route can shape its response.
 *
 * The background tasks themselves live in `platform-jobs.ts`, each with a
 * minimum interval — a task held back by its interval reports `'skipped'` in
 * the completion log line rather than being omitted (#442).
 */

import { logger } from '@/lib/logging';
import { processDueSchedules } from '@/lib/orchestration/scheduling';
import { runDueAppJobs } from '@/lib/orchestration/maintenance/app-jobs';
import {
  PLATFORM_JOB_NAMES,
  runDuePlatformJobs,
} from '@/lib/orchestration/maintenance/platform-jobs';

/** Module-level guard against overlapping tick executions. */
let tickRunning = false;

/**
 * Per-tick monotonic token. Each accepted tick claims a fresh token and
 * tags its background chain + watchdog with it. Only the owning token
 * can release `tickRunning` — prevents a late-settling old chain (whose
 * watchdog already force-released the guard) from accidentally
 * releasing a newer tick's guard.
 */
let currentTickToken = 0;

/** Exposed for testing only — simulate an in-progress tick. */
export function __test_setTickRunning(value: boolean): void {
  tickRunning = value;
}

/**
 * Background task names, in run order — published by the tick route as
 * `backgroundTasks`. Derived from `PLATFORM_JOBS` so the list and the tasks
 * that actually run cannot drift apart.
 */
export const BACKGROUND_TASK_NAMES = PLATFORM_JOB_NAMES;

/**
 * Watchdog timeout for the background chain. Five minutes is a generous
 * upper bound — any single maintenance task taking longer than this is
 * a real incident worth flagging via the warning log line.
 */
const BACKGROUND_TASK_MAX_MS = 5 * 60 * 1000;

export type ScheduleResult = Awaited<ReturnType<typeof processDueSchedules>> | { error: string };

export interface TickResult {
  /** Skipped because a previous tick was still running. */
  skipped: boolean;
  /** Result of the awaited schedules sweep — undefined when `skipped`. */
  schedules?: ScheduleResult;
  /** Tick start time (epoch ms). */
  startMs: number;
}

/**
 * Run one maintenance tick. The schedules sweep is awaited; the rest of
 * the chain settles in the background under the overlap guard.
 */
export async function runMaintenanceTick(): Promise<TickResult> {
  const startMs = Date.now();
  if (tickRunning) {
    logger.info('Maintenance tick skipped — previous tick still running');
    return { skipped: true, startMs };
  }

  tickRunning = true;
  const myTickToken = ++currentTickToken;

  let schedules: ScheduleResult;
  try {
    schedules = await processDueSchedules();
  } catch (err) {
    schedules = { error: err instanceof Error ? err.message : String(err) };
  }

  const watchdogId = setTimeout(() => {
    if (currentTickToken !== myTickToken || !tickRunning) return;
    logger.warn('Maintenance tick: background chain exceeded max duration; releasing guard', {
      maxDurationMs: BACKGROUND_TASK_MAX_MS,
      tickStartMs: startMs,
    });
    tickRunning = false;
  }, BACKGROUND_TASK_MAX_MS);

  void Promise.allSettled([
    // Sunrise's own tasks, each gated by its own minimum interval (#442). The
    // helper contains per-task failures itself, so a rejection here would mean
    // the registry rather than a sweep.
    runDuePlatformJobs(startMs),
    // Fork-owned seam (#469). Second so app work never delays Sunrise's own
    // maintenance. `runDueAppJobs` never throws and returns undefined when no
    // jobs are registered, so vanilla Sunrise is unaffected.
    runDueAppJobs(),
  ])
    .then(([platformResult, appJobsResult]) => {
      const summary =
        platformResult.status === 'fulfilled'
          ? platformResult.value
          : { error: String(platformResult.reason) };
      // Only logged when the fork actually registered something, so the line
      // stays unchanged upstream.
      const appJobs =
        appJobsResult.status === 'fulfilled'
          ? appJobsResult.value
          : { error: String(appJobsResult.reason) };

      logger.info('Maintenance tick background tasks completed', {
        ...summary,
        ...(appJobs ? { appJobs } : {}),
        totalDurationMs: Date.now() - startMs,
      });
    })
    .finally(() => {
      clearTimeout(watchdogId);
      if (currentTickToken === myTickToken) {
        tickRunning = false;
      }
    });

  return { skipped: false, schedules, startMs };
}
