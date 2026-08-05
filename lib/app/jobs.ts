/**
 * App recurring-job registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: the maintenance tick calls this once before it first runs app jobs
 * (server runtime). Add `registerAppJob({ name, intervalMs, run })` calls to run
 * your own periodic work on the existing tick instead of standing up a second
 * scheduler:
 *
 *   import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';
 *
 *   export function initAppJobs(): void {
 *     registerAppJob({
 *       name: 'app:prune-draft-invoices',
 *       intervalMs: 6 * 60 * 60 * 1000, // 6 hours
 *       run: async () => {
 *         const { count } = await prisma.appInvoice.deleteMany({ ... });
 *         return { pruned: count };   // folded into the tick's log line
 *       },
 *     });
 *   }
 *
 * `intervalMs` is a **minimum** gap, not a guarantee, and last-run times live in
 * process memory — so a multi-instance deployment runs each job about once per
 * instance per interval, and a restart re-arms everything. Write jobs to be
 * idempotent. If a job must run exactly once cluster-wide it needs its own lease;
 * see `execution-reaper` for that pattern.
 *
 * Empty registry = today's behaviour, byte-for-byte.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/scheduling.md
 */
import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';
import {
  processQueuedRespondentReports,
  processQueuedReportRevisions,
} from '@/lib/app/questionnaire/report/worker';
import { enforceAppRetentionPolicies } from '@/lib/app/questionnaire/retention';

/**
 * ConQuest's recurring work.
 *
 * These three ran inline in the platform tick's background chain before Sunrise
 * 0.8.0 opened this seam (#469); they moved here on the 0.7.0 → 0.8.0 sync so
 * `run-tick.ts` stops being a fork-edited platform file.
 *
 * All three are registered at tick cadence (`intervalMs` = 60s, below the
 * shortest interval the tick itself can run at), which reproduces the previous
 * every-tick behaviour exactly. Two reasons not to space them out:
 *
 *  - The report workers drain a queue a respondent is waiting on. Any gate above
 *    the tick interval is added latency on a finished questionnaire.
 *  - On Vercel the clock is meaningless anyway — last-run times live in process
 *    memory and every cron invocation is a fresh process, so a longer interval
 *    would be honoured on the dev ticker and silently ignored in production.
 *    Better to say "every tick" than to imply a cadence that only holds locally.
 *
 * Cadence is therefore set by `vercel.json`'s cron schedule (hourly), not here.
 * All three are idempotent: the workers claim rows under a worker id and the
 * prune is a cutoff-based `deleteMany`.
 */
export function initAppJobs(): void {
  registerAppJob({
    name: 'app:respondentReports',
    intervalMs: 60_000,
    run: processQueuedRespondentReports,
  });

  registerAppJob({
    name: 'app:respondentReportRevisions',
    intervalMs: 60_000,
    run: processQueuedReportRevisions,
  });

  // App-owned prune (F14.15): turn evaluations, design-eval runs, AI run
  // provenance. Kept in `lib/app/**` so it survives upstream syncs of the
  // platform retention module.
  registerAppJob({
    name: 'app:appRetention',
    intervalMs: 60_000,
    run: enforceAppRetentionPolicies,
  });
}
