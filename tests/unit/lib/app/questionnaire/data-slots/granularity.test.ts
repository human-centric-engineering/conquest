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
  HIGH_COHESION_ANCHOR,
  LOW_COHESION_ANCHOR,
  buildConsolidationProfile,
  consolidationIndex,
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

const typed = (n: number) => Array.from({ length: n }, () => ({ type: 'likert' }));
const freeText = (n: number) => Array.from({ length: n }, () => ({ type: 'free_text' }));

describe('buildConsolidationProfile', () => {
  it('derives the free-text share from the questions in scope', () => {
    const profile = buildConsolidationProfile([...typed(3), ...freeText(1)], 0.7);
    expect(profile).toEqual({ questionCount: 4, freeTextShare: 0.25, cohesion: 0.7 });
  });

  it('defaults cohesion to null (unmeasured), not 0', () => {
    // 0 would be a real measurement meaning "maximally distinct"; null means "no signal", and the
    // two must not collapse — an un-embedded version would otherwise be shoved fully finer.
    expect(buildConsolidationProfile(typed(4)).cohesion).toBeNull();
  });

  it('reports a zero share for an empty scope without dividing by zero', () => {
    expect(buildConsolidationProfile([]).freeTextShare).toBe(0);
  });
});

describe('consolidationIndex', () => {
  it('pulls fully broader for typed siblings', () => {
    // A likert battery: every question sits next to a near-twin, and each still maps onto its own
    // scale point at down-propagation — the one case where heavy consolidation is genuinely right.
    const index = consolidationIndex(buildConsolidationProfile(typed(10), HIGH_COHESION_ANCHOR));
    expect(index).toBe(1);
  });

  it('pulls fully finer for typed questions that all stand alone', () => {
    const index = consolidationIndex(buildConsolidationProfile(typed(10), LOW_COHESION_ANCHOR));
    expect(index).toBe(-1);
  });

  it('pulls finer for an all-free-text set EVEN when its questions are near-identical', () => {
    // The load-bearing case. The three ego/Higher-Self questions embed almost identically, so a
    // similarity-only signal would broaden — straight back into the defect. Free text records one
    // position per slot, so similarity must not license grouping it.
    const index = consolidationIndex(buildConsolidationProfile(freeText(10), 0.95));
    expect(index).toBe(-1);
  });

  it('leaves the band alone when a cohesive typed half offsets a free-text half', () => {
    const index = consolidationIndex(
      buildConsolidationProfile([...typed(5), ...freeText(5)], HIGH_COHESION_ANCHOR)
    );
    expect(index).toBe(0);
  });

  it('drops the semantic term entirely when cohesion is unmeasured', () => {
    // No embeddings → the type mix alone decides. All-typed with no signal means no shift.
    expect(consolidationIndex(buildConsolidationProfile(typed(10)))).toBe(0);
    expect(consolidationIndex(buildConsolidationProfile(freeText(10)))).toBe(-1);
  });

  it('scales smoothly between the anchors rather than switching at a threshold', () => {
    const midpoint = (LOW_COHESION_ANCHOR + HIGH_COHESION_ANCHOR) / 2;
    expect(consolidationIndex(buildConsolidationProfile(typed(10), midpoint))).toBeCloseTo(0, 5);
    const upper = consolidationIndex(buildConsolidationProfile(typed(10), midpoint + 0.05));
    expect(upper).toBeGreaterThan(0);
    expect(upper).toBeLessThan(1);
  });

  it('clamps cohesion beyond either anchor instead of overshooting', () => {
    expect(consolidationIndex(buildConsolidationProfile(typed(10), 1))).toBe(1);
    expect(consolidationIndex(buildConsolidationProfile(typed(10), 0))).toBe(-1);
  });
});

describe('targetSlotRange with a consolidation profile', () => {
  const QUESTIONS = 30;

  it('leaves the band untouched without a profile (back-compat)', () => {
    expect(targetSlotRange('balanced', QUESTIONS)).toEqual({ min: 14, max: 17 });
  });

  it('moves a distinct free-text set from balanced onto granular ground', () => {
    // The Lelañea case: 30 largely free-text questions. Balanced used to demand ~14–17 slots,
    // forcing exactly the over-consolidation that bundled three ego questions into one slot.
    const fine = targetSlotRange('balanced', QUESTIONS, buildConsolidationProfile(freeText(30)));
    const flat = targetSlotRange('balanced', QUESTIONS);
    expect(fine.min).toBeGreaterThan(flat.min);
    expect(fine.max).toBeGreaterThan(flat.max);
    // A full pull lands on the adjacent level's band exactly — granular, not finest.
    expect(fine).toEqual(targetSlotRange('granular', QUESTIONS));
  });

  it('moves a cohesive typed set from balanced onto broad ground', () => {
    const broad = targetSlotRange(
      'balanced',
      QUESTIONS,
      buildConsolidationProfile(typed(30), HIGH_COHESION_ANCHOR)
    );
    expect(broad).toEqual(targetSlotRange('broad', QUESTIONS));
  });

  it('never shifts further than one adjacent level', () => {
    // The admin's choice stays the primary control — content nudges it, it does not override it.
    const pulled = targetSlotRange('balanced', QUESTIONS, buildConsolidationProfile(freeText(30)));
    expect(pulled.max).toBeLessThan(targetSlotRange('finest', QUESTIONS).min);
  });

  it('holds at the ends, where there is no neighbour to move toward', () => {
    // `finest` is already ~1:1 and `broadest` already maximally consolidated; a further pull in
    // the same direction has nowhere to go and must not silently invert to the other neighbour.
    expect(targetSlotRange('finest', QUESTIONS, buildConsolidationProfile(freeText(30)))).toEqual(
      targetSlotRange('finest', QUESTIONS)
    );
    expect(
      targetSlotRange(
        'broadest',
        QUESTIONS,
        buildConsolidationProfile(typed(30), HIGH_COHESION_ANCHOR)
      )
    ).toEqual(targetSlotRange('broadest', QUESTIONS));
  });

  it('interpolates partway for a partial pull', () => {
    const half = buildConsolidationProfile([...typed(15), ...freeText(15)]);
    const partial = targetSlotRange('balanced', QUESTIONS, half);
    const flat = targetSlotRange('balanced', QUESTIONS);
    const full = targetSlotRange('granular', QUESTIONS);
    expect(partial.max).toBeGreaterThan(flat.max);
    expect(partial.max).toBeLessThan(full.max);
  });

  it('still floors min at 1 and caps max at the question count under a pull', () => {
    const tiny = targetSlotRange('broadest', 2, buildConsolidationProfile(freeText(2)));
    expect(tiny.min).toBeGreaterThanOrEqual(1);
    expect(tiny.max).toBeLessThanOrEqual(2);
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
