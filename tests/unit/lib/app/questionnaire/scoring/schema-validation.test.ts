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
