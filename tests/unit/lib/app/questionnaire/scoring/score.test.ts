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

/**
 * C8 — the common ruler.
 *
 * The failure these guard against is silent: a scale drawing on a 1–6 battery and a 1–5 one
 * combines two different rulers, produces a number, and says nothing. Every case below therefore
 * asserts the *difference* between normalised and raw arithmetic rather than just that a number
 * came out.
 */
describe('scoreSession — normalise (C8)', () => {
  const mixedBounds = new Map([
    ['likert5', { min: 1, max: 5 }],
    ['likert6', { min: 1, max: 6 }],
    ['unbounded', { min: 0, max: 0 }],
  ]);

  const mixedSchema = (over: Partial<ScoringSchemaContent> = {}): ScoringSchemaContent => ({
    method: 'mean',
    scales: [{ key: 'growth', name: 'Growth' }],
    items: [
      { source: 'question', ref: 'likert5', scaleKey: 'growth', weight: 1, reverse: false },
      { source: 'question', ref: 'likert6', scaleKey: 'growth', weight: 1, reverse: false },
    ],
    bands: [],
    ...over,
  });

  it('off by default, so a pre-C8 schema keeps combining raw values', () => {
    const scores = scoreSession(
      mixedSchema(),
      new Map([
        ['likert5', 4],
        ['likert6', 4],
      ]),
      mixedBounds
    );
    // Both answers are "4", so the raw mean is 4 — the arithmetic that treats 4-of-5 and 4-of-6 as
    // the same quantity. This is the bug; it is preserved when the flag is off.
    expect(scores.growth.raw).toBe(4);
  });

  it('places each item at its position within its own range before combining', () => {
    const scores = scoreSession(
      mixedSchema({ normalise: true }),
      new Map([
        ['likert5', 4],
        ['likert6', 4],
      ]),
      mixedBounds
    );
    // 4 of 1–5 → 0.75; 4 of 1–6 → 0.6. Mean 0.675 — and crucially not equal to either item.
    expect(scores.growth.raw).toBeCloseTo(0.675, 5);
    expect(scores.growth.itemCount).toBe(2);
  });

  it('scores a full-marks answer as 1 on every ruler', () => {
    const scores = scoreSession(
      mixedSchema({ normalise: true }),
      new Map([
        ['likert5', 5],
        ['likert6', 6],
      ]),
      mixedBounds
    );
    expect(scores.growth.raw).toBeCloseTo(1, 5);
  });

  it('reverses and normalises together', () => {
    const scores = scoreSession(
      mixedSchema({
        normalise: true,
        items: [
          { source: 'question', ref: 'likert6', scaleKey: 'growth', weight: 1, reverse: true },
        ],
      }),
      new Map([['likert6', 2]]),
      mixedBounds
    );
    // Reverse: (1 + 6) - 2 = 5. Normalise: (5 - 1) / 5 = 0.8. The pinned value is the point — a
    // reversed item must end up high on the common ruler when the raw answer was low, and it must
    // use ITS OWN 1–6 range to get there, not the 1–5 one its scale-mate uses.
    expect(scores.growth.raw).toBeCloseTo(0.8, 5);
  });

  it('drops an item with no bounds rather than mixing it in raw', () => {
    const scores = scoreSession(
      mixedSchema({
        normalise: true,
        items: [
          { source: 'question', ref: 'likert5', scaleKey: 'growth', weight: 1, reverse: false },
          { source: 'question', ref: 'noBounds', scaleKey: 'growth', weight: 1, reverse: false },
        ],
      }),
      new Map([
        ['likert5', 4],
        ['noBounds', 37],
      ]),
      mixedBounds
    );
    // Without the drop, 37 would swamp the scale outright. itemCount records the drop against the
    // schema's two items, which is how the shortfall stays visible downstream.
    expect(scores.growth.raw).toBeCloseTo(0.75, 5);
    expect(scores.growth.itemCount).toBe(1);
    expect(scores.growth.totalItemCount).toBe(2);
  });

  it('drops an item whose bounds are degenerate rather than dividing by zero', () => {
    const scores = scoreSession(
      mixedSchema({
        normalise: true,
        items: [
          { source: 'question', ref: 'likert5', scaleKey: 'growth', weight: 1, reverse: false },
          { source: 'question', ref: 'unbounded', scaleKey: 'growth', weight: 1, reverse: false },
        ],
      }),
      new Map([
        ['likert5', 4],
        ['unbounded', 0],
      ]),
      mixedBounds
    );
    expect(Number.isFinite(scores.growth.raw)).toBe(true);
    expect(scores.growth.itemCount).toBe(1);
  });

  it('omits a scale whose every item was dropped for want of a ruler', () => {
    const scores = scoreSession(
      mixedSchema({
        normalise: true,
        items: [
          { source: 'dataSlot', ref: 'noBounds', scaleKey: 'growth', weight: 1, reverse: false },
        ],
      }),
      new Map([['noBounds', 3]]),
      mixedBounds
    );
    expect(scores.growth).toBeUndefined();
  });

  it('honours weights on the normalised values', () => {
    const scores = scoreSession(
      mixedSchema({
        normalise: true,
        items: [
          { source: 'question', ref: 'likert5', scaleKey: 'growth', weight: 3, reverse: false },
          { source: 'question', ref: 'likert6', scaleKey: 'growth', weight: 1, reverse: false },
        ],
      }),
      new Map([
        ['likert5', 5],
        ['likert6', 1],
      ]),
      mixedBounds
    );
    // (3 × 1 + 1 × 0) / 4 = 0.75
    expect(scores.growth.raw).toBeCloseTo(0.75, 5);
  });

  it('matches bands authored in 0–1', () => {
    const scores = scoreSession(
      mixedSchema({
        normalise: true,
        bands: [
          { scaleKey: 'growth', min: 0, max: 0.5, label: 'Low' },
          { scaleKey: 'growth', min: 0.5, max: 1, label: 'High' },
        ],
      }),
      new Map([
        ['likert5', 4],
        ['likert6', 4],
      ]),
      mixedBounds
    );
    expect(scores.growth.band).toBe('High');
  });
});
