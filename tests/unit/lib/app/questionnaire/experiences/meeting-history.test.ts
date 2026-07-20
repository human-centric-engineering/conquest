/**
 * `narrowRefinementHistory` (P15.5) — the boundary between a Json column and a prompt.
 *
 * This data reaches the synthesis material and therefore a model, so it is narrowed rather than
 * cast. The recurring rule: one malformed entry must not cost a facilitator the other nine
 * movements in a breakout.
 */

import { describe, it, expect } from 'vitest';

import { narrowRefinementHistory } from '@/lib/app/questionnaire/experiences/meeting/history';

const VALID = {
  previousValue: 'fine',
  previousProvenance: 'direct',
  newValue: 'stretched',
  rationale: 'Changed after hearing the dates',
  source: 'refinement',
  previousConfidence: 0.4,
  newConfidence: 0.9,
};

describe('narrowRefinementHistory', () => {
  it('narrows a well-formed entry', () => {
    const [entry] = narrowRefinementHistory([VALID]);
    expect(entry).toMatchObject({
      previousValue: 'fine',
      newValue: 'stretched',
      rationale: 'Changed after hearing the dates',
      previousConfidence: 0.4,
      newConfidence: 0.9,
    });
  });

  it('returns empty for anything that is not an array', () => {
    for (const bad of [null, undefined, {}, 'nonsense', 42]) {
      expect(narrowRefinementHistory(bad)).toEqual([]);
    }
  });

  it('drops ONE malformed entry without losing the others', () => {
    // The load-bearing behaviour: a bad row must not cost the breakout its whole story.
    const result = narrowRefinementHistory([VALID, null, 'junk', { ...VALID, newValue: 'later' }]);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.newValue)).toEqual(['stretched', 'later']);
  });

  it('drops an entry with no rationale — it carries no story', () => {
    expect(narrowRefinementHistory([{ ...VALID, rationale: '' }])).toEqual([]);
    expect(narrowRefinementHistory([{ ...VALID, rationale: '   ' }])).toEqual([]);
    expect(narrowRefinementHistory([{ ...VALID, rationale: 42 }])).toEqual([]);
  });

  it('falls back to a known provenance rather than passing junk through', () => {
    const [entry] = narrowRefinementHistory([{ ...VALID, previousProvenance: 'invented' }]);
    expect(entry.previousProvenance).toBe('direct');
  });

  it('nulls a non-finite confidence rather than letting NaN reach a prompt', () => {
    // Both NaN and Infinity survive a JSON round-trip through a hand-edited row.
    const [entry] = narrowRefinementHistory([
      { ...VALID, previousConfidence: Number.NaN, newConfidence: Number.POSITIVE_INFINITY },
    ]);
    expect(entry.previousConfidence).toBeNull();
    expect(entry.newConfidence).toBeNull();
  });

  it('omits a non-numeric turnIndex rather than emitting undefined', () => {
    const [entry] = narrowRefinementHistory([{ ...VALID, turnIndex: 'third' }]);
    expect(entry).not.toHaveProperty('turnIndex');
  });

  it('keeps a valid turnIndex', () => {
    const [entry] = narrowRefinementHistory([{ ...VALID, turnIndex: 3 }]);
    expect(entry.turnIndex).toBe(3);
  });

  it('preserves object-valued sides untouched — the material renders them safely', () => {
    const [entry] = narrowRefinementHistory([
      { ...VALID, previousValue: { a: 1 }, newValue: { a: 2 } },
    ]);
    expect(entry.previousValue).toEqual({ a: 1 });
    expect(entry.newValue).toEqual({ a: 2 });
  });
});
