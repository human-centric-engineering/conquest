/**
 * Unit tests for truncateSnapshot — the pure snapshot-capping function behind
 * AppAiRun's `promptSnapshot`/`outputSnapshot` capture (F14.15).
 *
 * @see lib/app/questionnaire/ai-run/types.ts
 */

import { describe, it, expect } from 'vitest';

import {
  truncateSnapshot,
  AI_RUN_SNAPSHOT_MAX_CHARS,
  AI_RUN_TRUNCATION_MARKER,
} from '@/lib/app/questionnaire/ai-run/types';

describe('truncateSnapshot', () => {
  it('passes a null/undefined input through as { value: null, truncated: false }', () => {
    expect(truncateSnapshot(null)).toEqual({ value: null, truncated: false });
    expect(truncateSnapshot(undefined)).toEqual({ value: null, truncated: false });
  });

  it('passes an under-cap string through unchanged', () => {
    const text = 'a short prompt';
    const result = truncateSnapshot(text);

    expect(result).toEqual({ value: text, truncated: false });
  });

  it('passes an under-cap object through unchanged (not stringified)', () => {
    const obj = { role: 'critic', flags: ['suspect'] };
    const result = truncateSnapshot(obj);

    // The object shape survives — a reader downstream needs it queryable as JSON,
    // not as a stringified blob.
    expect(result.value).toBe(obj);
    expect(result.truncated).toBe(false);
  });

  it('cuts an over-cap string at the char cap and appends the truncation marker', () => {
    const text = 'x'.repeat(AI_RUN_SNAPSHOT_MAX_CHARS + 1000);

    const result = truncateSnapshot(text);

    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    const value = result.value as string;
    expect(value.endsWith(AI_RUN_TRUNCATION_MARKER)).toBe(true);
    expect(value.length).toBe(AI_RUN_SNAPSHOT_MAX_CHARS + AI_RUN_TRUNCATION_MARKER.length);
  });

  it('does NOT truncate a string exactly at the cap (boundary is inclusive)', () => {
    const text = 'x'.repeat(AI_RUN_SNAPSHOT_MAX_CHARS);

    const result = truncateSnapshot(text);

    expect(result.truncated).toBe(false);
    expect(result.value).toBe(text);
  });

  it('serialises a non-string value before measuring, and caps it when the serialised form overflows', () => {
    // A single-question object stays small when serialised, but a very large
    // array of questions must be measured — and capped — as JSON text, the
    // same way a giant prompt string would be.
    const bigArray = Array.from({ length: 5000 }, (_, i) => ({
      key: `question_${i}`,
      prompt: 'A question long enough to add real weight to the JSON payload.',
    }));

    const result = truncateSnapshot(bigArray);

    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    // The truncated value is JSON-serialised text (starts like the array's own
    // JSON.stringify output), not the original array shape.
    expect((result.value as string).startsWith(JSON.stringify(bigArray).slice(0, 20))).toBe(true);
    expect((result.value as string).endsWith(AI_RUN_TRUNCATION_MARKER)).toBe(true);
  });

  it('does not throw on a cyclic object, and reports it as unserialisable rather than truncated', () => {
    const cyclic: Record<string, unknown> = { name: 'self-referential' };
    cyclic.self = cyclic;

    expect(() => truncateSnapshot(cyclic)).not.toThrow();
    const result = truncateSnapshot(cyclic);

    // safeStringify catches the throw and returns null; truncateSnapshot maps
    // that to a fixed sentinel rather than crashing the caller's write path.
    expect(result).toEqual({ value: '[unserialisable]', truncated: false });
  });

  it('treats numbers and booleans as measurable via their serialised form', () => {
    expect(truncateSnapshot(42)).toEqual({ value: 42, truncated: false });
    expect(truncateSnapshot(true)).toEqual({ value: true, truncated: false });
  });
});
