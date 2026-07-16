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
 */

import { logger } from '@/lib/logging';
import {
  processDueSchedules,
  processOrphanedExecutions,
  processPendingExecutions,
} from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';
import { processPendingEvaluationRuns } from '@/lib/orchestration/evaluations/run-worker';
import {
  processQueuedRespondentReports,
  processQueuedReportRevisions,
} from '@/lib/app/questionnaire/report/worker';

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

export const BACKGROUND_TASK_NAMES = [
  'webhookRetries',
  'hookRetries',
  'orphanSweep',
  'zombieReaper',
  'embeddingBackfill',
  'retention',
  'pendingExecutionRecovery',
  'evaluationRuns',
  'respondentReports',
  'respondentReportRevisions',
] as const;

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

/** Options for {@link runMaintenanceTick}. */
export interface RunMaintenanceTickOptions {
  /**
   * Await the background task chain (embeddings, retention, evaluation runs, respondent reports,
   * …) before returning, instead of detaching it as fire-and-forget.
   *
   * REQUIRED on serverless (Vercel), where the function is frozen/killed once the HTTP response
   * is sent — a detached `void Promise.allSettled(...)` chain is not guaranteed to run to
   * completion, so queued reports / eval runs / retries never drain. The scheduled-cron endpoint
   * passes `true`; the dev in-process ticker and the manual admin tick keep the default
   * fire-and-forget behaviour (they run on a persistent process / return 202 fast).
   *
   * @default false
   */
  awaitBackground?: boolean;
}

/**
 * Run one maintenance tick. The schedules sweep is always awaited. The rest of the chain either
 * settles in the background under the overlap guard (default) or is awaited before returning when
 * {@link RunMaintenanceTickOptions.awaitBackground} is set (serverless cron).
 */
export async function runMaintenanceTick(
  opts: RunMaintenanceTickOptions = {}
): Promise<TickResult> {
  const { awaitBackground = false } = opts;
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

  const chain = Promise.allSettled([
    processPendingRetries(),
    processPendingHookRetries(),
    processOrphanedExecutions(),
    reapZombieExecutions(),
    backfillMissingEmbeddings(),
    enforceRetentionPolicies(),
    processPendingExecutions(),
    processPendingEvaluationRuns(),
    processQueuedRespondentReports(),
    processQueuedReportRevisions(),
  ])
    .then((settled) => {
      const summary = Object.fromEntries(
        BACKGROUND_TASK_NAMES.map((name, i) => {
          const result = settled[i];
          return [
            name,
            result.status === 'fulfilled' ? result.value : { error: String(result.reason) },
          ];
        })
      );
      logger.info('Maintenance tick background tasks completed', {
        ...summary,
        totalDurationMs: Date.now() - startMs,
      });
    })
    .finally(() => {
      clearTimeout(watchdogId);
      if (currentTickToken === myTickToken) {
        tickRunning = false;
      }
    });

  // Serverless (Vercel): await the chain so it actually completes within the function invocation.
  // Persistent-process callers (dev ticker, admin tick) detach it and return fast.
  if (awaitBackground) {
    await chain;
  } else {
    void chain;
  }

  return { skipped: false, schedules, startMs };
}
