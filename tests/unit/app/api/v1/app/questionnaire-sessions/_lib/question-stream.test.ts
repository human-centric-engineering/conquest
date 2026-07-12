/**
 * Unit tests for `extractLikertScale` / `extractMatrix` — the streaming question phraser's
 * best-effort likert bounds + endpoint-anchor reader, and the matrix rows + shared-scale
 * reader built on top of it (F6.1 clarifying fallback).
 *
 * Pins: explicit `minLabel`/`maxLabel` win outright; a full `labels` array supplies the
 * endpoints when no explicit labels are set; bounds-only configs return no labels; and
 * malformed/non-object/inverted-range input returns `undefined`.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/question-stream.ts
 */

import { describe, it, expect } from 'vitest';

import {
  extractLikertScale,
  extractMatrix,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';

describe('extractLikertScale', () => {
  it('prefers explicit minLabel/maxLabel over any labels array', () => {
    expect(
      extractLikertScale({ min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very much' })
    ).toEqual({ min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very much' });
  });

  it('resolves each endpoint independently — explicit on one side, array-derived on the other', () => {
    // `endLabel` runs per side: an explicit minLabel wins for the low end while the high end
    // still falls back to the labels array's last entry.
    expect(
      extractLikertScale({
        min: 1,
        max: 5,
        minLabel: 'Not at all',
        labels: ['a', 'b', 'c', 'd', 'e'],
      })
    ).toEqual({ min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'e' });
  });

  it('falls back to the ends of a full labels array when no explicit endpoint labels are set', () => {
    expect(extractLikertScale({ min: 1, max: 5, labels: ['a', 'b', 'c', 'd', 'e'] })).toEqual({
      min: 1,
      max: 5,
      minLabel: 'a',
      maxLabel: 'e',
    });
  });

  it('returns bare bounds with no labels when neither endpoint labels nor a labels array are present', () => {
    expect(extractLikertScale({ min: 1, max: 5 })).toEqual({ min: 1, max: 5 });
  });

  it('ignores a labels array whose length does not match the scale (no wrong-anchor mapping)', () => {
    // A 3-entry array on a 5-point scale must NOT yield maxLabel='c' (labels[2]) as the "5" anchor.
    expect(extractLikertScale({ min: 1, max: 5, labels: ['a', 'b', 'c'] })).toEqual({
      min: 1,
      max: 5,
    });
    // An explicit endpoint still wins even when the array length is wrong.
    expect(
      extractLikertScale({ min: 1, max: 5, minLabel: 'Low', labels: ['a', 'b', 'c'] })
    ).toEqual({ min: 1, max: 5, minLabel: 'Low' });
  });

  it('returns undefined for non-object / null input', () => {
    expect(extractLikertScale(null)).toBeUndefined();
    expect(extractLikertScale('nope')).toBeUndefined();
    expect(extractLikertScale(undefined)).toBeUndefined();
  });

  it('returns undefined when bounds are missing or inverted', () => {
    expect(extractLikertScale({})).toBeUndefined();
    expect(extractLikertScale({ min: 5, max: 1 })).toBeUndefined();
    expect(extractLikertScale({ min: 5, max: 5 })).toBeUndefined();
  });
});

describe('extractMatrix', () => {
  it('returns rows + endpoint-anchored scale merged into one object (happy path)', () => {
    expect(
      extractMatrix({
        rows: [
          { key: 'comfort', label: 'Comfort' },
          { key: 'style', label: 'Style' },
        ],
        scale: { min: 1, max: 5, minLabel: 'Not important', maxLabel: 'Essential' },
      })
    ).toEqual({
      rows: ['Comfort', 'Style'],
      min: 1,
      max: 5,
      minLabel: 'Not important',
      maxLabel: 'Essential',
    });
  });

  it('returns rows + bare bounds when the shared scale has no labels', () => {
    expect(
      extractMatrix({
        rows: [{ key: 'r1', label: 'Reliability' }],
        scale: { min: 1, max: 3 },
      })
    ).toEqual({ rows: ['Reliability'], min: 1, max: 3 });
  });

  it('trims row labels and drops malformed/unlabelled row entries, keeping the valid ones', () => {
    expect(
      extractMatrix({
        rows: [
          { key: 'r1', label: '  Padded  ' },
          { key: 'r2', label: '' }, // empty label — dropped
          { key: 'r3' }, // no label field — dropped
          'not-an-object', // dropped
          null, // dropped
          { key: 'r4', label: 'Kept' },
        ],
        scale: { min: 1, max: 5 },
      })
    ).toEqual({ rows: ['Padded', 'Kept'], min: 1, max: 5 });
  });

  it('returns undefined when rows is missing, not an array, or empty', () => {
    const scale = { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' };
    expect(extractMatrix({ scale })).toBeUndefined();
    expect(extractMatrix({ rows: 'nope', scale })).toBeUndefined();
    expect(extractMatrix({ rows: [], scale })).toBeUndefined();
  });

  it('returns undefined when every row entry is malformed or unlabelled', () => {
    const scale = { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' };
    expect(extractMatrix({ rows: [{ key: 'r1' }, 'nope', null], scale })).toBeUndefined();
    expect(extractMatrix({ rows: [{ key: 'r1', label: '   ' }], scale })).toBeUndefined();
  });

  it('returns undefined when the shared scale is missing or invalid', () => {
    const rows = [{ key: 'r1', label: 'Comfort' }];
    expect(extractMatrix({ rows })).toBeUndefined();
    expect(extractMatrix({ rows, scale: null })).toBeUndefined();
    expect(extractMatrix({ rows, scale: {} })).toBeUndefined();
    expect(extractMatrix({ rows, scale: { min: 5, max: 1 } })).toBeUndefined();
  });

  it('returns undefined for non-object / null input', () => {
    expect(extractMatrix(null)).toBeUndefined();
    expect(extractMatrix('nope')).toBeUndefined();
    expect(extractMatrix(undefined)).toBeUndefined();
  });
});
