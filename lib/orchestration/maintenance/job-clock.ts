/**
 * Start-to-start job clock with an in-flight latch.
 *
 * Extracted from `app-jobs.ts` (#469) so the platform's own maintenance tasks
 * can be throttled by the same mechanism the fork seam already uses (#442).
 * Behaviour is unchanged from the maps it replaces — this is a move, not a
 * redesign.
 *
 * Two pieces of state per job name:
 *
 *  - **last-run stamp**, written when a job *starts*, so `intervalMs` measures
 *    start-to-start. End-to-start would let a slow job drift its own cadence.
 *  - **in-flight latch**, so a job slower than its interval is never started a
 *    second time and left to stack up concurrent copies.
 *
 * ## Per-process, by design
 *
 * State lives in this process's memory. A multi-instance deployment runs each
 * job roughly once per instance per interval, and a restart re-arms everything
 * immediately. Persisting the clock would cost a database round-trip per job per
 * tick — exactly the cost #442 exists to remove. Every throttled task is
 * idempotent, so the failure mode is "ran more often than intended", never
 * "missed work".
 *
 * @see lib/orchestration/maintenance/app-jobs.ts — fork-owned jobs
 * @see lib/orchestration/maintenance/platform-jobs.ts — Sunrise's own tasks
 */

/** A per-name start-to-start clock with an in-flight latch. */
export interface JobClock {
  /**
   * True when `name` is neither running nor inside its minimum gap. An
   * `intervalMs` of `0` means "every tick" — a job that must stay responsive.
   */
  isDue(name: string, intervalMs: number, now: number): boolean;
  /** Stamp the run and latch the name. Call immediately before invoking the job. */
  markStarted(name: string, now: number): void;
  /** Release the latch. Call from a `finally`, so a rejection can't wedge the job. */
  markSettled(name: string): void;
  /** Drop all state. Test-only — a fresh clock per test file, not per process. */
  reset(): void;
}

/** Create an independent clock. Registries must not share one — names would collide. */
export function createJobClock(): JobClock {
  const lastRunAt = new Map<string, number>();
  const inFlight = new Set<string>();

  return {
    isDue(name, intervalMs, now) {
      // Still running from an earlier tick — never start a second copy, however
      // long ago it became due.
      if (inFlight.has(name)) return false;
      const last = lastRunAt.get(name);
      return last === undefined || now - last >= intervalMs;
    },
    markStarted(name, now) {
      lastRunAt.set(name, now);
      inFlight.add(name);
    },
    markSettled(name) {
      inFlight.delete(name);
    },
    reset() {
      lastRunAt.clear();
      inFlight.clear();
    },
  };
}
