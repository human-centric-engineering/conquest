/**
 * Progress channel — bridging a fire-and-forget progress callback into an async generator.
 *
 * Several ConQuest flows are one long `await` from the route's point of view (a turn, a report
 * preview) but cross several announceable boundaries inside. The core wants to stay a plain async
 * function — it should not know it is being streamed — so it is handed a synchronous, side-effect-
 * only emitter it calls as it crosses a boundary. A plain callback cannot `yield`, so this is the
 * channel between the two: {@link ProgressChannel.emit} fills a queue, and
 * {@link ProgressChannel.drain} pulls from that queue concurrently with the core's promise and turns
 * each entry into something the route can stream.
 *
 * Passing no emitter is always valid and changes nothing, which is what keeps every existing caller
 * and test of an instrumented core working untouched.
 *
 * This is the generic form of the turn-stage channel it was extracted from — the drain loop's
 * termination argument is subtle enough that two copies of it is a bug waiting to happen.
 *
 * Pure — no React, no I/O, no Next.js imports.
 *
 * @see lib/app/questionnaire/orchestrator/stage-progress.ts — the turn-stage channel
 * @see lib/app/questionnaire/report/preview-run.ts — the report-preview stream
 */

/** What an instrumented core is handed: fire-and-forget, never awaited, never able to throw upward. */
export type ProgressEmitter<T> = (value: T) => void;

export interface ProgressChannel<T> {
  /** Hand this to the core being instrumented. */
  emit: ProgressEmitter<T>;
  /**
   * Drive `until` to completion, yielding each emitted value as it arrives and finally returning
   * the core's own result. Rejections propagate unchanged, so a caller's existing try/catch around
   * the promise keeps working exactly as it did.
   */
  drain<R>(until: Promise<R>): AsyncGenerator<T, R, undefined>;
}

export interface ProgressChannelOptions<T> {
  /**
   * Collapse consecutive duplicates: when this returns the same non-null key as the previous
   * ENQUEUED value, the new value is dropped. Re-announcing the same thing reads as the surface
   * having stalled and restarted. Return `null` (or omit the option) to announce everything.
   */
  dedupeKey?: (value: T) => string | null;
}

/**
 * A one-shot channel for a single run. Not reusable — the de-dup memory below is per-run state, and
 * a shared channel would swallow the second run's first value.
 */
export function createProgressChannel<T>(
  options: ProgressChannelOptions<T> = {}
): ProgressChannel<T> {
  const { dedupeKey } = options;
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let lastKey: string | null = null;

  const emit: ProgressEmitter<T> = (value) => {
    const key = dedupeKey ? dedupeKey(value) : null;
    if (key !== null && key === lastKey) return;
    lastKey = key;
    queue.push(value);
    wake?.();
    wake = null;
  };

  async function* drain<R>(until: Promise<R>): AsyncGenerator<T, R, undefined> {
    let settled = false;
    let value: R;
    let failure: unknown;
    let failed = false;

    // Attach BOTH handlers up front so `done` itself never rejects — it is only ever used as a
    // wake-up race below, and an unhandled rejection there would crash the process rather than
    // surface as the failure the caller already knows how to render.
    const done = until.then(
      (v) => {
        value = v;
        settled = true;
        wake?.();
        wake = null;
      },
      (e) => {
        failure = e;
        failed = true;
        settled = true;
        wake?.();
        wake = null;
      }
    );

    for (;;) {
      while (queue.length > 0) {
        yield queue.shift() as T;
      }
      if (settled) break;
      // Termination rests on `wake` being reachable from BOTH sides: `emit` calls it when a value
      // arrives, and the settle handlers above call it when the core finishes. `wake` is assigned
      // synchronously inside the executor below, with no await between it and the `settled` check,
      // so as written there is no window in which the core could settle un-noticed and strand this
      // await.
      //
      // Racing `done` is belt-and-braces for the edit that introduces such a window — inserting any
      // `await` between the check and the assignment would otherwise turn a hang into the failure
      // mode, and a hung drain means a stream that never closes.
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = null;
    }

    if (failed) throw failure;
    return value!;
  }

  return { emit, drain };
}
