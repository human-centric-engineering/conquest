/**
 * Unit tests: the generic progress channel.
 *
 * This module sits between a plain async core and an async-generator route, which makes its worst
 * failure mode a **hang** rather than a wrong answer: if the drain loop ever waits on a resolver
 * nobody will call, the stream never closes and the caller's dialog spins forever — which is the
 * exact symptom the report-preview stream exists to remove. So the cases below lean on the shapes
 * that could strand it: a core that emits nothing, one that emits and settles in the same tick, one
 * that rejects, and one that keeps emitting after the drain has caught up.
 *
 * Every test is wrapped in a real timeout, so such a regression fails the suite rather than hanging
 * it. The turn-stage channel's own contract (de-dup on the stage, label mapping) is covered by
 * `orchestrator/stage-progress.test.ts`, which now exercises this module through its delegate.
 */

import { describe, expect, it } from 'vitest';

import { createProgressChannel } from '@/lib/app/questionnaire/llm/progress-channel';

/** Reject rather than hang if the channel deadlocks — a hang would take the whole run with it. */
function withTimeout<T>(p: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('progress channel deadlocked')), ms)
    ),
  ]);
}

/** Yield to the macrotask queue so an awaiting drain loop gets a turn to run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Collect every value the channel yields while `run` executes, plus the core's own result. */
async function collect<T, R>(
  run: (emit: (value: T) => void) => Promise<R>,
  options?: Parameters<typeof createProgressChannel<T>>[0]
): Promise<{ values: T[]; result: R }> {
  const channel = createProgressChannel<T>(options);
  const gen = channel.drain(run(channel.emit));
  const values: T[] = [];
  let step = await gen.next();
  while (!step.done) {
    values.push(step.value);
    step = await gen.next();
  }
  return { values, result: step.value };
}

describe('createProgressChannel', () => {
  it('yields each emitted value in order and returns the core result', async () => {
    const { values, result } = await withTimeout(
      collect<string, number>(async (emit) => {
        emit('a');
        await tick();
        emit('b');
        await tick();
        emit('c');
        return 42;
      })
    );

    expect(values).toEqual(['a', 'b', 'c']);
    expect(result).toBe(42);
  });

  it('terminates when the core emits nothing at all', async () => {
    const { values, result } = await withTimeout(
      collect<string, string>(async () => {
        await tick();
        return 'quiet';
      })
    );

    expect(values).toEqual([]);
    expect(result).toBe('quiet');
  });

  it('still yields values emitted in the same tick the core settles in', async () => {
    const { values, result } = await withTimeout(
      collect<string, string>(async (emit) => {
        emit('one');
        emit('two');
        return 'done';
      })
    );

    expect(values).toEqual(['one', 'two']);
    expect(result).toBe('done');
  });

  it('propagates a rejection after draining what was already emitted', async () => {
    const channel = createProgressChannel<string>();
    const gen = channel.drain(
      (async () => {
        channel.emit('started');
        await tick();
        throw new Error('core exploded');
      })()
    );

    const first = await withTimeout(gen.next());
    expect(first.value).toBe('started');
    await expect(withTimeout(gen.next())).rejects.toThrow('core exploded');
  });

  it('announces every value by default, including consecutive duplicates', async () => {
    const { values } = await withTimeout(
      collect<{ done: number }, void>(async (emit) => {
        emit({ done: 1 });
        await tick();
        emit({ done: 1 });
        await tick();
        emit({ done: 2 });
      })
    );

    expect(values).toEqual([{ done: 1 }, { done: 1 }, { done: 2 }]);
  });

  it('collapses consecutive duplicates when a dedupeKey is supplied', async () => {
    const { values } = await withTimeout(
      collect<string, void>(
        async (emit) => {
          emit('reading');
          await tick();
          emit('reading');
          await tick();
          emit('writing');
          await tick();
          // Not consecutive any more — de-dup is against the previous ENQUEUED value only.
          emit('reading');
        },
        { dedupeKey: (v) => v }
      )
    );

    expect(values).toEqual(['reading', 'writing', 'reading']);
  });

  it('keeps draining values emitted after the loop has caught up', async () => {
    // The shape that strands a naive implementation: the drain empties the queue and starts waiting,
    // and only then does the core emit again.
    const { values, result } = await withTimeout(
      collect<string, string>(async (emit) => {
        emit('first');
        await tick();
        await tick();
        emit('second');
        await tick();
        await tick();
        emit('third');
        return 'ok';
      })
    );

    expect(values).toEqual(['first', 'second', 'third']);
    expect(result).toBe('ok');
  });
});
