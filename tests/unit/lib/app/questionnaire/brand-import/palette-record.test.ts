/**
 * Unit tests: the persisted brand palette.
 *
 * This module is the boundary between a `Json?` column and a rendered swatch strip, so the two
 * halves it has to get right are opposite in temperament:
 *
 *  - the WRITE schema is strict, because a browser posting a malformed palette should be told
 *    (and because an uncapped array would put an unbounded blob in the row);
 *  - the READ narrowing is forgiving, because the column can hold whatever a seed, a rollback or
 *    an older build left there, and a branding page that throws is far worse than one with no
 *    strip on it.
 *
 * `describeSource` is tested here rather than through the dialog because it is the only place the
 * provenance line is composed, and asserting on it via a rendered React tree would test the tree.
 *
 * @see lib/app/questionnaire/brand-import/palette-record.ts
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_STORED_CANDIDATES,
  brandPaletteSchema,
  describeSource,
  narrowBrandPalette,
} from '@/lib/app/questionnaire/brand-import/palette-record';

const CAPTURED_AT = '2026-08-31T09:00:00.000Z';

function palette(candidates: { hex: string; share: number; neutral: boolean }[]) {
  return { candidates, readFrom: 'acme.example', capturedAt: CAPTURED_AT };
}

const VALID = palette([
  { hex: '#0a1a3a', share: 0.62, neutral: false },
  { hex: '#ffffff', share: 0.3, neutral: true },
]);

describe('brandPaletteSchema (write boundary)', () => {
  it('accepts a measured palette and keeps its order', () => {
    const parsed = brandPaletteSchema.parse(VALID);
    expect(parsed.candidates.map((c) => c.hex)).toEqual(['#0a1a3a', '#ffffff']);
    expect(parsed.readFrom).toBe('acme.example');
    expect(parsed.capturedAt).toBe(CAPTURED_AT);
  });

  it('lower-cases hexes so a chip and a stored colour compare equal', () => {
    // The strip keys its swatches by hex and the form's own fields store lower-case, so `#0A1A3A`
    // and `#0a1a3a` arriving as two candidates would render as two chips for one colour.
    const parsed = brandPaletteSchema.parse(
      palette([{ hex: '#0A1A3A', share: 1, neutral: false }])
    );
    expect(parsed.candidates[0].hex).toBe('#0a1a3a');
  });

  it('rejects the three-digit short form', () => {
    // Six digits everywhere: the theme columns store six, and `#fff` vs `#ffffff` would make one
    // colour look like two when the strip is read against the fields it filled.
    expect(
      brandPaletteSchema.safeParse(palette([{ hex: '#fff', share: 1, neutral: true }])).success
    ).toBe(false);
  });

  it('rejects a share expressed as a percentage', () => {
    // 62 rather than 0.62 draws a band one colour wide and a chip reading "6200.0%". Typing it as
    // a plain number would have let that through.
    expect(
      brandPaletteSchema.safeParse(palette([{ hex: '#0a1a3a', share: 62, neutral: false }])).success
    ).toBe(false);
  });

  it('rejects an empty candidate list', () => {
    // "We measured nothing" is expressed by storing NO palette, not by storing an empty one — the
    // strip would otherwise render a header and provenance over a blank band.
    expect(brandPaletteSchema.safeParse(palette([])).success).toBe(false);
  });

  it('caps the number of candidates it will store', () => {
    const tooMany = Array.from({ length: MAX_STORED_CANDIDATES + 1 }, (_, i) => ({
      hex: `#0000${i.toString(16).padStart(2, '0')}`,
      share: 0.01,
      neutral: false,
    }));
    expect(brandPaletteSchema.safeParse(palette(tooMany)).success).toBe(false);
    expect(
      brandPaletteSchema.safeParse(palette(tooMany.slice(0, MAX_STORED_CANDIDATES))).success
    ).toBe(true);
  });

  it('rejects a capturedAt that is not an ISO timestamp', () => {
    expect(brandPaletteSchema.safeParse({ ...VALID, capturedAt: '31 August 2026' }).success).toBe(
      false
    );
  });

  it('accepts a null readFrom', () => {
    // A screenshot-only import with no address still measured real colours; refusing to store them
    // because we cannot name a source would discard the expensive half of the run.
    expect(brandPaletteSchema.parse({ ...VALID, readFrom: null }).readFrom).toBeNull();
  });
});

describe('narrowBrandPalette (read boundary)', () => {
  it('returns the palette when the column holds one', () => {
    expect(narrowBrandPalette(VALID)?.candidates).toHaveLength(2);
  });

  it.each([
    ['null (the column has never been written)', null],
    ['a Prisma JSON null', undefined],
    ['a string left by an older build', 'acme.example'],
    ['an array rather than the record', [{ hex: '#0a1a3a', share: 1, neutral: false }]],
    ['a record missing capturedAt', { candidates: VALID.candidates, readFrom: null }],
    ['a record whose candidates are malformed', { ...VALID, candidates: [{ hex: 'navy' }] }],
  ])('returns null for %s rather than throwing', (_label, value) => {
    expect(narrowBrandPalette(value)).toBeNull();
  });
});

describe('describeSource', () => {
  it('names the address alone when there were no screenshots', () => {
    expect(describeSource('acme.example', 0)).toBe('acme.example');
  });

  it('strips the scheme and any trailing slash so the line reads as a name', () => {
    expect(describeSource('https://acme.example/', 0)).toBe('acme.example');
  });

  it('counts screenshots when there is no address', () => {
    expect(describeSource('', 2)).toBe('2 screenshots');
    expect(describeSource('   ', 1)).toBe('1 screenshot');
  });

  it('names both when the admin gave both — the combination the import prefers', () => {
    expect(describeSource('acme.example', 3)).toBe('acme.example + 3 screenshots');
  });

  it('returns null when there is nothing to name', () => {
    expect(describeSource('', 0)).toBeNull();
  });
});
