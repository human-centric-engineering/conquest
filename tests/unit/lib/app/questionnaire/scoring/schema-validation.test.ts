/**
 * Unit test: scoring schema validation (F14.4).
 *
 * Asserts `narrowScoringSchemaContent` drops malformed scales/items/bands and prunes items/bands that
 * reference an unknown scale, and that the strict `scoringSchemaContentSchema` accepts a valid schema
 * and rejects unknown-scale references + inverted bands.
 */

import { describe, it, expect } from 'vitest';

import {
  narrowScoringSchemaContent,
  scoringSchemaContentSchema,
} from '@/lib/app/questionnaire/scoring/schema-validation';

describe('narrowScoringSchemaContent', () => {
  it('keeps valid entries and prunes references to unknown scales', () => {
    const out = narrowScoringSchemaContent({
      method: 'sum',
      scales: [
        { key: 'open', name: 'Openness' },
        { bad: true }, // dropped (no key/name)
      ],
      items: [
        { source: 'question', ref: 'q1', scaleKey: 'open', weight: 2, reverse: true },
        { source: 'question', ref: 'q2', scaleKey: 'ghost', weight: 1, reverse: false }, // unknown scale
      ],
      bands: [
        { scaleKey: 'open', min: 0, max: 5, label: 'All' },
        { scaleKey: 'ghost', min: 0, max: 1, label: 'X' }, // unknown scale
      ],
    });
    expect(out.method).toBe('sum');
    expect(out.scales).toHaveLength(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].weight).toBe(2);
    expect(out.bands).toHaveLength(1);
  });

  it('defaults to an empty mean schema for garbage', () => {
    expect(narrowScoringSchemaContent('nope')).toEqual({
      scales: [],
      items: [],
      bands: [],
      method: 'mean',
      // C8: off, because the only safe reading of "nothing was said" is the behaviour every
      // schema had before the flag existed.
      normalise: false,
    });
  });
});

describe('scoringSchemaContentSchema', () => {
  const valid = {
    method: 'mean' as const,
    scales: [{ key: 'open', name: 'Openness' }],
    items: [
      { source: 'question' as const, ref: 'q1', scaleKey: 'open', weight: 1, reverse: false },
    ],
    bands: [{ scaleKey: 'open', min: 1, max: 5, label: 'All' }],
  };

  it('accepts a valid schema', () => {
    expect(scoringSchemaContentSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an item referencing an unknown scale', () => {
    const bad = { ...valid, items: [{ ...valid.items[0], scaleKey: 'ghost' }] };
    expect(scoringSchemaContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a band with max < min', () => {
    const bad = { ...valid, bands: [{ scaleKey: 'open', min: 5, max: 1, label: 'X' }] };
    expect(scoringSchemaContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate scale keys', () => {
    const bad = {
      ...valid,
      scales: [
        { key: 'open', name: 'A' },
        { key: 'open', name: 'B' },
      ],
    };
    expect(scoringSchemaContentSchema.safeParse(bad).success).toBe(false);
  });
});

/**
 * C8 — band cutoffs must follow the ruler.
 *
 * Turning normalisation on rescales what a score means. Left unchecked, cutoffs written in the
 * questions' own units match nothing: every respondent gets `band: null` and the cohort report's
 * band breakdown empties out, with nothing anywhere naming the cause. The save is the last place
 * that failure is still attributable, so these assert it is refused there.
 */
describe('scoringSchemaContentSchema — normalise (C8)', () => {
  const base = {
    method: 'mean' as const,
    scales: [{ key: 'open', name: 'Openness' }],
    items: [
      { source: 'question' as const, ref: 'q1', scaleKey: 'open', weight: 1, reverse: false },
      { source: 'question' as const, ref: 'q2', scaleKey: 'open', weight: 1, reverse: false },
    ],
    bands: [{ scaleKey: 'open', min: 1, max: 5, label: 'All' }],
  };

  it('accepts the flag itself', () => {
    const ok = { ...base, normalise: false };
    expect(scoringSchemaContentSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects raw-unit band cutoffs once normalisation is on', () => {
    const bad = { ...base, normalise: true };
    const result = scoringSchemaContentSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('0–1');
    }
  });

  it('accepts 0–1 band cutoffs under mean', () => {
    const ok = {
      ...base,
      normalise: true,
      bands: [
        { scaleKey: 'open', min: 0, max: 0.5, label: 'Low' },
        { scaleKey: 'open', min: 0.5, max: 1, label: 'High' },
      ],
    };
    expect(scoringSchemaContentSchema.safeParse(ok).success).toBe(true);
  });

  it('allows the ceiling to reach the item count under sum', () => {
    // Two items, each contributing at most 1 once normalised, so the scale tops out at 2 — not 1.
    const ok = {
      ...base,
      method: 'sum' as const,
      normalise: true,
      bands: [{ scaleKey: 'open', min: 0, max: 2, label: 'All' }],
    };
    expect(scoringSchemaContentSchema.safeParse(ok).success).toBe(true);

    const bad = { ...ok, bands: [{ scaleKey: 'open', min: 0, max: 3, label: 'All' }] };
    expect(scoringSchemaContentSchema.safeParse(bad).success).toBe(false);
  });

  it('leaves raw-unit bands alone when normalisation is off', () => {
    expect(scoringSchemaContentSchema.safeParse(base).success).toBe(true);
  });
});

describe('narrowScoringSchemaContent — normalise (C8)', () => {
  it('reads an absent flag as off, so a pre-C8 schema keeps its values', () => {
    const narrowed = narrowScoringSchemaContent({
      scales: [{ key: 'open', name: 'Openness' }],
      items: [],
      bands: [],
      method: 'mean',
    });
    expect(narrowed.normalise).toBe(false);
  });

  it('reads only a literal true as on', () => {
    const base = { scales: [{ key: 'open', name: 'Openness' }], items: [], bands: [] };
    expect(narrowScoringSchemaContent({ ...base, normalise: true }).normalise).toBe(true);
    expect(narrowScoringSchemaContent({ ...base, normalise: 'yes' }).normalise).toBe(false);
  });
});
