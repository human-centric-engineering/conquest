/**
 * Bounded-concurrency fan-out helper — pure unit tests.
 *
 * Shared by the data-slot generator and the report-preview sample answerer; both rely on it to keep
 * a large questionnaire from opening one provider socket per question.
 *
 * @see lib/app/questionnaire/llm/run-with-concurrency.ts
 */

import { describe, it, expect, vi } from 'vitest';

import {
  runWithConcurrency,
  mapWithConcurrency,
} from '@/lib/app/questionnaire/llm/run-with-concurrency';

/** A task that resolves after `ms`, recording peak overlap through the shared counter. */
function tracked(counter: { current: number; peak: number }) {
  return async (item: { id: number; ms: number }) => {
    counter.current += 1;
    counter.peak = Math.max(counter.peak, counter.current);
    await new Promise((resolve) => setTimeout(resolve, item.ms));
    counter.current -= 1;
    return item.id;
  };
}

describe('runWithConcurrency', () => {
  it('runs every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i, ms: 0 }));
    const results = await mapWithConcurrency(items, 4, async (item) => item.id);

    expect(results).toHaveLength(25);
    expect(new Set(results).size).toBe(25);
    expect([...results].sort((a, b) => a - b)).toEqual(items.map((i) => i.id));
  });

  it('never exceeds the concurrency limit', async () => {
    const counter = { current: 0, peak: 0 };
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, ms: 5 }));

    await mapWithConcurrency(items, 3, tracked(counter));

    expect(counter.peak).toBe(3);
    expect(counter.current).toBe(0);
  });

  it('keeps the pipe full — a slow item does not stall the rest', async () => {
    const counter = { current: 0, peak: 0 };
    // One very slow item first; with a naive batching scheme the remaining items would wait on it.
    const items = [
      { id: 0, ms: 40 },
      ...Array.from({ length: 9 }, (_, i) => ({ id: i + 1, ms: 1 })),
    ];

    const results = await mapWithConcurrency(items, 3, tracked(counter));

    expect(results).toHaveLength(10);
    // The slow item is still running while later items complete, so it is not the first result.
    expect(results[0]).not.toBe(0);
    expect(results.at(-1)).toBe(0);
  });

  it('caps at the item count when the limit exceeds it', async () => {
    const counter = { current: 0, peak: 0 };
    const items = [
      { id: 1, ms: 5 },
      { id: 2, ms: 5 },
    ];

    await mapWithConcurrency(items, 10, tracked(counter));

    expect(counter.peak).toBe(2);
  });

  it('handles an empty item list without invoking the task', async () => {
    const fn = vi.fn();
    expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats a limit below 1 as 1 rather than deadlocking', async () => {
    const counter = { current: 0, peak: 0 };
    const items = Array.from({ length: 4 }, (_, i) => ({ id: i, ms: 1 }));

    const results = await mapWithConcurrency(items, 0, tracked(counter));

    expect(results).toHaveLength(4);
    expect(counter.peak).toBe(1);
  });

  it('yields results as they complete rather than buffering to the end', async () => {
    const items = [
      { id: 0, ms: 30 },
      { id: 1, ms: 1 },
    ];
    const seen: number[] = [];

    for await (const id of runWithConcurrency(items, 2, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item.ms));
      return item.id;
    })) {
      seen.push(id);
    }

    expect(seen).toEqual([1, 0]);
  });

  it('propagates a task rejection to the caller', async () => {
    const items = [{ id: 0, ms: 1 }];
    await expect(
      mapWithConcurrency(items, 2, async () => {
        throw new Error('task blew up');
      })
    ).rejects.toThrow('task blew up');
  });
});
