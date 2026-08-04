/**
 * Bounded-concurrency fan-out for app LLM work.
 *
 * The app's large-questionnaire flows all share one shape: a single LLM call that must emit one
 * output per question (or per data slot) truncates once the questionnaire gets big, so the work is
 * split into groups and run in parallel. This is the scheduler those flows share — it keeps at most
 * `limit` calls in flight so a 200-question version can't open 200 sockets at the provider and trip
 * its rate limit.
 *
 * Results are yielded as they complete, NOT in input order — callers that need input order must
 * carry an index on the item and re-sort (both current callers key their results explicitly).
 *
 * Server-side only in practice (its callers hold providers), but the helper itself is pure.
 */

/** Run `fn` over `items` with at most `limit` in flight, yielding each result as it completes. */
export async function* runWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>
): AsyncGenerator<O> {
  // Guard before the launch loop: `cap` floors at 1, so an empty list would otherwise launch one
  // task against `items[0]` (undefined) and fail inside the caller's own callback.
  if (items.length === 0) return;

  const executing = new Map<number, Promise<{ key: number; value: O }>>();
  let next = 0;
  const launch = () => {
    const key = next;
    const item = items[next];
    next += 1;
    executing.set(
      key,
      fn(item).then((value) => ({ key, value }))
    );
  };
  const cap = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < cap; i += 1) launch();
  while (executing.size > 0) {
    const { key, value } = await Promise.race(executing.values());
    executing.delete(key);
    yield value;
    if (next < items.length) launch();
  }
}

/** Collect {@link runWithConcurrency} into an array — completion order, not input order. */
export async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>
): Promise<O[]> {
  const results: O[] = [];
  for await (const result of runWithConcurrency(items, limit, fn)) results.push(result);
  return results;
}
