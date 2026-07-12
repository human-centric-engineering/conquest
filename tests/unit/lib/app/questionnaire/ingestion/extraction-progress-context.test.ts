/**
 * Unit tests for the extraction progress-sink seam.
 *
 * The narrowing is the load-bearing part: the sink rides an `unknown`-typed
 * `entityContext` field, so `readExtractionProgressSink` must return a callable
 * ONLY when a real function is present and `undefined` otherwise — that
 * `undefined` is exactly what keeps the non-streaming ingest / re-ingest routes
 * on the blocking extraction path.
 *
 * @see lib/app/questionnaire/ingestion/extraction-progress-context.ts
 */

import { describe, it, expect } from 'vitest';

import {
  EXTRACTION_PROGRESS_CONTEXT_KEY,
  readExtractionProgressSink,
} from '@/lib/app/questionnaire/ingestion/extraction-progress-context';

describe('readExtractionProgressSink', () => {
  it('returns the function when a sink is present under the documented key', () => {
    const sink = (n: number): void => void n;
    const resolved = readExtractionProgressSink({ [EXTRACTION_PROGRESS_CONTEXT_KEY]: sink });
    expect(resolved).toBe(sink);
  });

  it('returns undefined when the entityContext is undefined', () => {
    expect(readExtractionProgressSink(undefined)).toBeUndefined();
  });

  it('returns undefined when the key is absent (the non-streaming callers)', () => {
    expect(
      readExtractionProgressSink({ extractorAgent: { provider: 'openai', model: 'x' } })
    ).toBeUndefined();
  });

  it('returns undefined when the value is present but not a function', () => {
    for (const notAFn of [42, 'nope', null, {}, []]) {
      expect(
        readExtractionProgressSink({ [EXTRACTION_PROGRESS_CONTEXT_KEY]: notAFn })
      ).toBeUndefined();
    }
  });

  it('resolves a sink that is actually callable', () => {
    const seen: number[] = [];
    const resolved = readExtractionProgressSink({
      [EXTRACTION_PROGRESS_CONTEXT_KEY]: (n: number) => seen.push(n),
    });
    resolved?.(3);
    expect(seen).toEqual([3]);
  });
});
