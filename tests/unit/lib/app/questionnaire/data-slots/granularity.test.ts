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

  it('gives every level a label, summary, and non-empty guidance', () => {
    for (const level of DATA_SLOT_GRANULARITY_LEVELS) {
      expect(level.label.length).toBeGreaterThan(0);
      expect(level.summary.length).toBeGreaterThan(0);
      expect(level.guidance.length).toBeGreaterThan(0);
    }
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
