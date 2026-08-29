/**
 * Unit tests: brand-import colour arithmetic.
 *
 * The numeric floor everything else stands on. `toHex`'s six-digit contract in particular is
 * load-bearing beyond formatting: the analyst's reply is checked against the candidate list by
 * exact string match, so a three-digit shortening here would silently discard real colours as
 * "not measured".
 */

import { describe, it, expect } from 'vitest';

import {
  NEUTRAL_CHROMA_THRESHOLD,
  chroma,
  distance,
  isNeutral,
  parseHex,
  toHex,
} from '@/lib/app/questionnaire/brand-import/color';

describe('parseHex', () => {
  it('expands the three-digit form', () => {
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it('reads the six-digit form, with or without the hash, in either case', () => {
    expect(parseHex('#5469D4')).toEqual({ r: 0x54, g: 0x69, b: 0xd4 });
    expect(parseHex('5469d4')).toEqual({ r: 0x54, g: 0x69, b: 0xd4 });
  });

  it('rejects anything that is not a hex colour', () => {
    expect(parseHex('rgb(1,2,3)')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('#gggggg')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('toHex', () => {
  it('always emits six lowercase digits, never the short form', () => {
    // #fff would be a legal CSS colour and an illegal candidate: the analyst's reply is matched
    // against this string, and '#fff' !== '#ffffff'.
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe('#ffffff');
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
  });

  it('rounds and clamps the averaged channels a bucket produces', () => {
    expect(toHex({ r: 127.6, g: 0.4, b: 10.5 })).toBe('#80000b');
    expect(toHex({ r: 300, g: -20, b: 128 })).toBe('#ff0080');
  });
});

describe('chroma / isNeutral', () => {
  it('reports zero chroma for every grey', () => {
    expect(chroma({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(chroma({ r: 128, g: 128, b: 128 })).toBe(0);
    expect(chroma({ r: 255, g: 255, b: 255 })).toBe(0);
  });

  it('treats greys, whites and near-blacks as neutral', () => {
    expect(isNeutral({ r: 255, g: 255, b: 255 })).toBe(true);
    expect(isNeutral({ r: 17, g: 17, b: 20 })).toBe(true);
  });

  it('treats a tinted paper stock as neutral so it can still serve as a canvas', () => {
    // #fffcf5 — the cream the form suggests for `canvasColor`. A brand-colour filter that
    // discarded it would make the most structurally important field unfillable.
    expect(isNeutral({ r: 255, g: 252, b: 245 })).toBe(true);
  });

  it('treats a saturated brand colour as non-neutral', () => {
    expect(isNeutral({ r: 0x54, g: 0x69, b: 0xd4 })).toBe(false);
    expect(chroma({ r: 0x54, g: 0x69, b: 0xd4 })).toBeGreaterThan(NEUTRAL_CHROMA_THRESHOLD);
  });
});

describe('distance', () => {
  it('is zero for a colour against itself', () => {
    expect(distance({ r: 10, g: 20, b: 30 }, { r: 10, g: 20, b: 30 })).toBe(0);
  });

  it('separates two different brand colours by more than it separates shades of one', () => {
    const blue = { r: 0x54, g: 0x69, b: 0xd4 };
    const nearlyTheSameBlue = { r: 0x56, g: 0x6b, b: 0xd6 };
    const teal = { r: 0x0f, g: 0xa3, b: 0x9a };
    expect(distance(blue, nearlyTheSameBlue)).toBeLessThan(distance(blue, teal));
  });
});
