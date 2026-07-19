/**
 * Unit tests for the Prisma JSON storage boundary.
 *
 * `jsonInput` is the single place that decides SQL-NULL vs JSON pass-through for every `Json`
 * column the app writes. Previously five byte-identical copies of it lived across the route
 * `_lib` modules; this is now the one definition, so it is worth pinning directly.
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

import { jsonArray, jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

describe('jsonInput', () => {
  it('maps null and undefined to the SQL-NULL sentinel', () => {
    expect(jsonInput(null)).toBe(Prisma.JsonNull);
    expect(jsonInput(undefined)).toBe(Prisma.JsonNull);
  });

  it('passes JSON values through untouched', () => {
    expect(jsonInput({ a: 1 })).toEqual({ a: 1 });
    expect(jsonInput([1, 2, 3])).toEqual([1, 2, 3]);
    expect(jsonInput('text')).toBe('text');
    expect(jsonInput(42)).toBe(42);
    expect(jsonInput(true)).toBe(true);
  });

  it('preserves falsy JSON values rather than collapsing them to SQL NULL', () => {
    // The nullish check must be `=== null || === undefined`, not a truthiness test — 0, '' and
    // false are legitimate stored values and must not become SQL NULL.
    expect(jsonInput(0)).toBe(0);
    expect(jsonInput('')).toBe('');
    expect(jsonInput(false)).toBe(false);
  });

  it('keeps an empty object/array distinct from null', () => {
    expect(jsonInput({})).toEqual({});
    expect(jsonInput([])).toEqual([]);
  });
});

describe('jsonArray', () => {
  it('returns the array as-is when the column holds one', () => {
    expect(jsonArray<number>([1, 2])).toEqual([1, 2]);
    expect(jsonArray<string>([])).toEqual([]);
  });

  it('defaults every non-array shape to an empty array', () => {
    // SQL NULL, JSON null, and a column that somehow holds a scalar or object must all read as
    // "no history" rather than throwing into the caller's append path.
    expect(jsonArray(null)).toEqual([]);
    expect(jsonArray(undefined)).toEqual([]);
    expect(jsonArray({ a: 1 })).toEqual([]);
    expect(jsonArray('text')).toEqual([]);
    expect(jsonArray(0)).toEqual([]);
  });

  it('returns a live reference, so callers may push onto it', () => {
    // data-slot-fills relies on this: it reads the history then pushes a new entry before writing.
    const stored = [{ n: 1 }];
    const history = jsonArray<{ n: number }>(stored);
    history.push({ n: 2 });
    expect(history).toHaveLength(2);
  });

  it('does NOT validate element shape — documented unsoundness, pinned deliberately', () => {
    // If this ever starts filtering, the callers' assumptions change; the test exists so that
    // becomes a conscious decision rather than a silent behaviour shift.
    const mixed = jsonArray<{ n: number }>([{ n: 1 }, 'not an entry', null]);
    expect(mixed).toHaveLength(3);
  });
});
