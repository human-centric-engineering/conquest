/**
 * Unit test: the deterministic scoring engine (F14.4).
 *
 * Asserts scoreSession's combine methods (weighted mean / sum), reverse-scoring on item bounds,
 * weights, band assignment + normalisation, that unanswered items are skipped, and that a scale with
 * no answered items is omitted.
 */

import { describe, it, expect } from 'vitest';

import { scoreSession } from '@/lib/app/questionnaire/scoring/score';
import type { ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

const bounds = new Map([
  ['q1', { min: 1, max: 5 }],
  ['q2', { min: 1, max: 5 }],
  ['q3', { min: 1, max: 5 }],
]);

function schema(over: Partial<ScoringSchemaContent> = {}): ScoringSchemaContent {
  return {
    method: 'mean',
    scales: [{ key: 'open', name: 'Openness' }],
    items: [
      { source: 'question', ref: 'q1', scaleKey: 'open', weight: 1, reverse: false },
      { source: 'question', ref: 'q2', scaleKey: 'open', weight: 1, reverse: false },
    ],
    bands: [
      { scaleKey: 'open', min: 1, max: 2.5, label: 'Low' },
      { scaleKey: 'open', min: 2.5, max: 5, label: 'High' },
    ],
    ...over,
  };
}

describe('scoreSession', () => {
  it('computes a weighted mean and assigns the band + normalisation', () => {
    const scores = scoreSession(
      schema(),
      new Map([
        ['q1', 4],
        ['q2', 5],
      ]),
      bounds
    );
    expect(scores.open.raw).toBe(4.5);
    expect(scores.open.itemCount).toBe(2);
    expect(scores.open.band).toBe('High');
    // normalised within the band span [1,5]: (4.5-1)/(5-1) = 0.875
    expect(scores.open.normalised).toBeCloseTo(0.875, 5);
  });

  it('sums weighted values under the sum method', () => {
    const scores = scoreSession(
      schema({ method: 'sum', bands: [] }),
      new Map([
        ['q1', 4],
        ['q2', 5],
      ]),
      bounds
    );
    expect(scores.open.raw).toBe(9);
    expect(scores.open.normalised).toBeNull(); // no bands
    expect(scores.open.band).toBeNull();
  });

  it('applies reverse-scoring on the item bounds', () => {
    const reversed = schema({
      items: [{ source: 'question', ref: 'q1', scaleKey: 'open', weight: 1, reverse: true }],
    });
    // q1=2 reversed on [1,5] → (1+5)-2 = 4
    const scores = scoreSession(reversed, new Map([['q1', 2]]), bounds);
    expect(scores.open.raw).toBe(4);
  });

  it('honours item weights in the weighted mean', () => {
    const weighted = schema({
      items: [
        { source: 'question', ref: 'q1', scaleKey: 'open', weight: 3, reverse: false },
        { source: 'question', ref: 'q2', scaleKey: 'open', weight: 1, reverse: false },
      ],
    });
    // (3*2 + 1*5) / (3+1) = 11/4 = 2.75
    const scores = scoreSession(
      weighted,
      new Map([
        ['q1', 2],
        ['q2', 5],
      ]),
      bounds
    );
    expect(scores.open.raw).toBeCloseTo(2.75, 5);
  });

  it('skips unanswered items and omits a scale with no answered items', () => {
    const two = schema({
      scales: [
        { key: 'open', name: 'Openness' },
        { key: 'consc', name: 'Conscientiousness' },
      ],
      items: [
        { source: 'question', ref: 'q1', scaleKey: 'open', weight: 1, reverse: false },
        { source: 'question', ref: 'q3', scaleKey: 'consc', weight: 1, reverse: false },
      ],
    });
    // Only q1 answered → 'open' present (raw 3), 'consc' omitted entirely.
    const scores = scoreSession(two, new Map([['q1', 3]]), bounds);
    expect(scores.open.raw).toBe(3);
    expect(scores.open.itemCount).toBe(1);
    expect(scores.consc).toBeUndefined();
  });

  it('does not reverse when bounds are unknown for the ref', () => {
    const reversed = schema({
      items: [{ source: 'question', ref: 'qX', scaleKey: 'open', weight: 1, reverse: true }],
    });
    const scores = scoreSession(reversed, new Map([['qX', 2]]), new Map());
    expect(scores.open.raw).toBe(2); // no bounds → value used as-is
  });
});
