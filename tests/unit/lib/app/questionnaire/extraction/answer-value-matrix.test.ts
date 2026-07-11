/**
 * Matrix answer-value validation (composite `{ rowKey: point }` map).
 *
 * @see lib/app/questionnaire/extraction/answer-value.ts
 */

import { describe, it, expect } from 'vitest';

import { validateAnswerValue } from '@/lib/app/questionnaire/extraction/answer-value';

const config = {
  rows: [
    { key: 'fuel_efficiency', label: 'Fuel efficiency' },
    { key: 'reliability', label: 'Reliability' },
  ],
  scale: { min: 1, max: 5, minLabel: 'Not important', maxLabel: 'Essential' },
};

describe('validateAnswerValue — matrix', () => {
  it('accepts a full composite map within range', () => {
    const r = validateAnswerValue('matrix', { fuel_efficiency: 5, reliability: 3 }, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ fuel_efficiency: 5, reliability: 3 });
  });

  it('allows a partial answer (some rows unrated)', () => {
    const r = validateAnswerValue('matrix', { fuel_efficiency: 4 }, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ fuel_efficiency: 4 });
  });

  it('coerces numeric strings to integers', () => {
    const r = validateAnswerValue('matrix', { fuel_efficiency: '5' }, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ fuel_efficiency: 5 });
  });

  it('rejects an unknown row key', () => {
    const r = validateAnswerValue('matrix', { not_a_row: 3 }, config);
    expect(r.ok).toBe(false);
  });

  it('rejects an out-of-range point', () => {
    expect(validateAnswerValue('matrix', { fuel_efficiency: 6 }, config).ok).toBe(false);
    expect(validateAnswerValue('matrix', { fuel_efficiency: 0 }, config).ok).toBe(false);
  });

  it('rejects a non-integer point', () => {
    expect(validateAnswerValue('matrix', { fuel_efficiency: 3.5 }, config).ok).toBe(false);
  });

  it('rejects a non-object value (scalar / array)', () => {
    expect(validateAnswerValue('matrix', 4, config).ok).toBe(false);
    expect(validateAnswerValue('matrix', [3, 4], config).ok).toBe(false);
    expect(validateAnswerValue('matrix', null, config).ok).toBe(false);
  });

  it('rejects an empty map (rated nothing)', () => {
    expect(validateAnswerValue('matrix', {}, config).ok).toBe(false);
  });
});
