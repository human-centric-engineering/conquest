/**
 * Tests: scripts/smoke/export-assertions.ts
 *
 * `isEmptySection` reconciles `meta.app`'s row counts against the payload the
 * subject actually receives: a section the manifest says holds nothing must
 * hold nothing, and the reverse. A predicate that answered "empty" too readily
 * would let `meta` and the bundle disagree while looking healthy.
 *
 * It is deliberately NOT the leak check — that tests `Array.isArray(value) &&
 * value.length > 0` directly, since only a row list can be assessed for a
 * stranger's rows. An earlier version of this docblock said otherwise.
 *
 * @see scripts/smoke/export.ts
 */

import { describe, it, expect } from 'vitest';
import { isEmptySection } from '@/scripts/smoke/export-assertions';

describe('isEmptySection', () => {
  it.each([
    ['an empty array — the normal shape', [], true],
    ['an empty object', {}, true],
    ['null', null, true],
    ['undefined — the key is absent', undefined, true],
  ])('treats %s as empty', (_label, value, expected) => {
    expect(isEmptySection(value)).toBe(expected);
  });

  it.each([
    ['one row', [{ id: 'r-1' }], false],
    ['many rows', [1, 2, 3], false],
    ['a keyed object with content', { total: 0 }, false],
    ['a nested empty array is still a key', { rows: [] }, false],
  ])('treats %s as NOT empty', (_label, value, expected) => {
    expect(isEmptySection(value)).toBe(expected);
  });

  it.each([
    ['a string', 'unexpected'],
    ['an empty string', ''],
    ['a number', 0],
    ['false', false],
  ])('treats %s — a shape the seam does not promise — as NOT empty', (_label, value) => {
    // Fail loudly on the unknown case. A tier returning a scalar for a declared
    // section is doing something the smoke script cannot reason about, and
    // "assume it is fine" is the wrong default for a leak check. `0` and `''`
    // are here specifically because a truthiness-based implementation would
    // call both empty.
    expect(isEmptySection(value)).toBe(false);
  });

  it('does not throw on a null-prototype object', () => {
    // `Object.keys` is safe here, but an implementation reaching for a method
    // on the value would not be — and a throw inside the assertion would fail
    // the smoke run with a stack trace instead of a finding.
    const bare = Object.create(null) as Record<string, unknown>;
    expect(isEmptySection(bare)).toBe(true);
    bare.leaked = 'row';
    expect(isEmptySection(bare)).toBe(false);
  });
});
