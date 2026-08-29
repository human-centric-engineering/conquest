/**
 * Unit tests: brand-import palette measurement.
 *
 * Runs against real images built with sharp rather than a mocked decoder, because the behaviours
 * that matter here are all consequences of real pixel data — antialiasing collapsing into one
 * bucket, a transparent margin not counting, a share that reflects area. A mocked `sharp` would
 * only assert that the arithmetic we wrote is the arithmetic we wrote.
 */

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

import { extractPalette, mergePalettes } from '@/lib/app/questionnaire/brand-import/palette';

/** Build a PNG from a pixel painter, so each test states its image in RGBA terms. */
async function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number]
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BRAND: [number, number, number, number] = [0x54, 0x69, 0xd4, 255];
const INK: [number, number, number, number] = [0x11, 0x11, 0x14, 255];

describe('extractPalette', () => {
  it('ranks colours by the area they cover', async () => {
    // Three quarters white ground, one quarter brand blue — the shape of a real page.
    const image = await png(256, 256, (x, y) => (x < 128 && y < 128 ? BRAND : WHITE));
    const palette = await extractPalette(image);

    expect(palette[0].hex).toBe('#ffffff');
    expect(palette[0].share).toBeGreaterThan(0.7);
    expect(palette[1].hex).toBe('#5469d4');
    expect(palette[1].share).toBeGreaterThan(0.2);
  });

  it('flags neutrals without discarding them, so a ground and an ink stay available', async () => {
    const image = await png(256, 256, (x, y) => {
      if (y < 40) return INK;
      if (x > 200 && y > 200) return BRAND;
      return WHITE;
    });
    const palette = await extractPalette(image);
    const byHex = new Map(palette.map((c) => [c.hex, c]));

    expect(byHex.get('#ffffff')?.neutral).toBe(true);
    expect(byHex.get('#111114')?.neutral).toBe(true);
    expect(byHex.get('#5469d4')?.neutral).toBe(false);
  });

  it('ignores transparent pixels, so a logo is measured by its mark and not its margin', async () => {
    // A wordmark on a transparent field: 90% of the file is nothing at all.
    const image = await png(256, 256, (_x, y) => (y > 100 && y < 140 ? BRAND : [0, 0, 0, 0]));
    const palette = await extractPalette(image);

    expect(palette).toHaveLength(1);
    expect(palette[0].hex).toBe('#5469d4');
    // Share is of the pixels that EXIST, not of the canvas — otherwise every logo's dominant
    // colour would be "transparent" and nothing would ever be proposed.
    expect(palette[0].share).toBeCloseTo(1, 2);
  });

  it('collapses a gradient into a handful of colours rather than hundreds', async () => {
    const image = await png(256, 256, (x) => [x, 0x40, 0xd4, 255]);
    const palette = await extractPalette(image);

    // 256 distinct source colours; the bucket-and-merge pass has to return something an admin
    // can scan. The cap is 12 and the merge should bring it under that on its own.
    expect(palette.length).toBeLessThanOrEqual(12);
    expect(palette.length).toBeGreaterThan(1);
  });

  it('returns nothing for bytes sharp cannot decode, rather than throwing', async () => {
    // A brand import runs over whatever a website served; one unreadable favicon must not fail
    // the whole import.
    await expect(extractPalette(Buffer.from('not an image'))).resolves.toEqual([]);
  });

  it('returns nothing for a fully transparent image', async () => {
    const image = await png(64, 64, () => [0, 0, 0, 0]);
    await expect(extractPalette(image)).resolves.toEqual([]);
  });
});

describe('mergePalettes', () => {
  it('weights a logo above a favicon rather than ranking on raw area', async () => {
    const logo = [{ hex: '#5469d4', share: 0.5, neutral: false }];
    const favicon = [{ hex: '#0fa39a', share: 1, neutral: false }];

    // The favicon is entirely its own colour and would win on share alone; the weighting says a
    // logo is more the brand than a favicon is.
    const merged = mergePalettes([
      { candidates: logo, weight: 4 },
      { candidates: favicon, weight: 1 },
    ]);

    expect(merged[0].hex).toBe('#5469d4');
  });

  it('folds the same colour found in two places into one entry', () => {
    const merged = mergePalettes([
      { candidates: [{ hex: '#5469d4', share: 0.5, neutral: false }], weight: 1 },
      { candidates: [{ hex: '#5568d3', share: 0.5, neutral: false }], weight: 1 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].share).toBeCloseTo(0.5, 5);
  });

  it('names a merged bucket after its heaviest contributor, not whoever arrived first', () => {
    // The Eagle Eye failure, in miniature. A logo's white margin and a page's warm paper stock are
    // 39 apart on the redmean scale, so they merge — and with the logo merged first, a site whose
    // ground is a cream could only ever be proposed `#ffffff`, a colour appearing nowhere on it.
    const logo = [{ hex: '#ffffff', share: 0.05, neutral: true }];
    const screenshot = [{ hex: '#f8f2ec', share: 0.8, neutral: true }];

    const merged = mergePalettes([
      { candidates: logo, weight: 2 },
      { candidates: screenshot, weight: 3 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].hex).toBe('#f8f2ec');
  });

  it('keeps the first hex when it is the heavier of the two', () => {
    // The mirror of the case above: order alone must not decide it either way.
    const merged = mergePalettes([
      { candidates: [{ hex: '#ffffff', share: 0.9, neutral: true }], weight: 3 },
      { candidates: [{ hex: '#f8f2ec', share: 0.1, neutral: true }], weight: 1 },
    ]);

    expect(merged[0].hex).toBe('#ffffff');
  });

  it('returns nothing when every source has zero weight', () => {
    expect(
      mergePalettes([{ candidates: [{ hex: '#5469d4', share: 1, neutral: false }], weight: 0 }])
    ).toEqual([]);
  });
});
