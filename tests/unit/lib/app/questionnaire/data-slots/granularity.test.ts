/**
 * Data-slot generation granularity — unit tests.
 *
 * Covers the ordered level table, the default, the Zod schema's defaulting +
 * rejection behaviour, and the guidance lookup. All pure (only the module + zod).
 *
 * @see lib/app/questionnaire/data-slots/granularity.ts
 */

import { describe, it, expect } from 'vitest';

import {
  DATA_SLOT_GRANULARITY_LEVELS,
  DEFAULT_DATA_SLOT_GRANULARITY,
  dataSlotGranularitySchema,
  granularityGuidance,
  targetSlotRange,
} from '@/lib/app/questionnaire/data-slots/granularity';

describe('DATA_SLOT_GRANULARITY_LEVELS', () => {
  it('defines exactly five levels, broad → fine', () => {
    expect(DATA_SLOT_GRANULARITY_LEVELS.map((l) => l.value)).toEqual([
      'broadest',
      'broad',
      'balanced',
      'granular',
      'finest',
    ]);
  });

  it('puts the default level in the middle', () => {
    expect(DATA_SLOT_GRANULARITY_LEVELS[2].value).toBe(DEFAULT_DATA_SLOT_GRANULARITY);
    expect(DEFAULT_DATA_SLOT_GRANULARITY).toBe('balanced');
  });

  it('gives every level a label, summary, non-empty guidance, and a sane ratio band', () => {
    for (const level of DATA_SLOT_GRANULARITY_LEVELS) {
      expect(level.label.length).toBeGreaterThan(0);
      expect(level.summary.length).toBeGreaterThan(0);
      expect(level.guidance.length).toBeGreaterThan(0);
      expect(level.ratio.min).toBeGreaterThan(0);
      expect(level.ratio.max).toBeGreaterThanOrEqual(level.ratio.min);
      expect(level.ratio.max).toBeLessThanOrEqual(1);
    }
  });

  it('has monotonically increasing ratios broad → fine', () => {
    const mids = DATA_SLOT_GRANULARITY_LEVELS.map((l) => (l.ratio.min + l.ratio.max) / 2);
    for (let i = 1; i < mids.length; i += 1) {
      expect(mids[i]).toBeGreaterThan(mids[i - 1]);
    }
  });
});

describe('targetSlotRange', () => {
  it('targets about half the question count at balanced (71 → 32–39)', () => {
    expect(targetSlotRange('balanced', 71)).toEqual({ min: 32, max: 39 });
  });

  it('targets few slots at broadest and near-1:1 at finest (71)', () => {
    expect(targetSlotRange('broadest', 71)).toEqual({ min: 11, max: 18 });
    expect(targetSlotRange('finest', 71)).toEqual({ min: 60, max: 71 });
  });

  it('increases monotonically across levels for a fixed question count', () => {
    const mid = (g: Parameters<typeof targetSlotRange>[0]) => {
      const { min, max } = targetSlotRange(g, 71);
      return (min + max) / 2;
    };
    expect(mid('broadest')).toBeLessThan(mid('broad'));
    expect(mid('broad')).toBeLessThan(mid('balanced'));
    expect(mid('balanced')).toBeLessThan(mid('granular'));
    expect(mid('granular')).toBeLessThan(mid('finest'));
  });

  it('floors min at 1 and never exceeds the question count', () => {
    expect(targetSlotRange('broadest', 2).min).toBe(1);
    const finest = targetSlotRange('finest', 5);
    expect(finest.max).toBeLessThanOrEqual(5);
  });
});

describe('dataSlotGranularitySchema', () => {
  it('defaults to balanced when the value is omitted', () => {
    expect(dataSlotGranularitySchema.parse(undefined)).toBe('balanced');
  });

  it('accepts each known level verbatim', () => {
    for (const level of DATA_SLOT_GRANULARITY_LEVELS) {
      expect(dataSlotGranularitySchema.parse(level.value)).toBe(level.value);
    }
  });

  it('rejects an unknown level', () => {
    expect(dataSlotGranularitySchema.safeParse('extreme').success).toBe(false);
  });
});

describe('granularityGuidance', () => {
  it('returns the matching level guidance', () => {
    expect(granularityGuidance('broadest')).toMatch(/consolidate aggressively/i);
    expect(granularityGuidance('finest')).toMatch(/maximise granularity/i);
  });

  it('matches the guidance stored on the level table', () => {
    for (const level of DATA_SLOT_GRANULARITY_LEVELS) {
      expect(granularityGuidance(level.value)).toBe(level.guidance);
    }
  });
});
