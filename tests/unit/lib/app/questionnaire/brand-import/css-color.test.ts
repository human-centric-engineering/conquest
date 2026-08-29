/**
 * Unit tests: reading colours out of CSS.
 *
 * The notation coverage is the point. A parser that handled only `#rrggbb` would work on an old
 * site and find nothing on a current one — Tailwind 4 emits `oklch()` for its whole palette — so
 * each notation gets a case, and the OKLab conversion gets its endpoints pinned because a sign
 * error in the matrix would still produce plausible-looking colours.
 */

import { describe, it, expect } from 'vitest';

import {
  extractColorFrequency,
  extractDeclaredBrandColors,
  parseCssColor,
} from '@/lib/app/questionnaire/brand-import/css-color';
import { toHex } from '@/lib/app/questionnaire/brand-import/color';

const hex = (token: string): string | null => {
  const rgb = parseCssColor(token);
  return rgb ? toHex(rgb) : null;
};

describe('parseCssColor', () => {
  it('reads every hex length, dropping the alpha the columns cannot store', () => {
    expect(hex('#abc')).toBe('#aabbcc');
    expect(hex('#5469d4')).toBe('#5469d4');
    // 4- and 8-digit forms carry an alpha. It is dropped rather than composited onto a background
    // we would have to guess — compositing would invent a colour that appears nowhere in the design.
    expect(hex('#5469d480')).toBe('#5469d4');
    expect(hex('#abcd')).toBe('#aabbcc');
  });

  it('reads rgb() in both the legacy comma form and the modern space form', () => {
    expect(hex('rgb(84, 105, 212)')).toBe('#5469d4');
    expect(hex('rgb(84 105 212)')).toBe('#5469d4');
    expect(hex('rgba(84, 105, 212, 0.5)')).toBe('#5469d4');
    expect(hex('rgb(84 105 212 / 50%)')).toBe('#5469d4');
  });

  it('reads hsl()', () => {
    expect(hex('hsl(0 0% 100%)')).toBe('#ffffff');
    expect(hex('hsl(0 0% 0%)')).toBe('#000000');
    expect(hex('hsl(0 100% 50%)')).toBe('#ff0000');
  });

  it('converts oklch, which is how a Tailwind 4 site states its palette', () => {
    // Tailwind 4's blue-500 token. Pinned because a sign error in the LMS matrix still produces a
    // colour, just the wrong one — an assertion that it is "some blue" would not catch that.
    expect(hex('oklch(0.623 0.214 259.815)')).toBe('#2b7fff');
    // A percentage lightness means the same thing, and both appear in real stylesheets.
    expect(hex('oklch(62.3% 0.214 259.815)')).toBe('#2b7fff');
  });

  it('pins the OKLab endpoints, where the conversion is unambiguous', () => {
    expect(hex('oklch(0 0 0)')).toBe('#000000');
    expect(hex('oklch(1 0 0)')).toBe('#ffffff');
  });

  it('clamps a wide-gamut colour into sRGB rather than producing a broken hex', () => {
    // A very high chroma lands outside sRGB; the columns are sRGB, so it has to be clamped and
    // still parse as a colour.
    expect(hex('oklch(0.7 0.4 30)')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('returns null for things that are not colours', () => {
    expect(hex('inherit')).toBeNull();
    expect(hex('var(--brand)')).toBeNull();
    expect(hex('url(logo.svg)')).toBeNull();
    expect(hex('rgb(84)')).toBeNull();
  });

  it('returns null for a function call that is none of the five notations read', () => {
    // A function-shaped token with three-plus args reaches the switch itself (unlike `rgb(84)`
    // above, which is rejected before the switch for having too few) — this is what actually
    // exercises its `default` arm.
    expect(hex('cmyk(0, 0, 0, 100)')).toBeNull();
  });

  it('reads oklab, the rectangular sibling of oklch', () => {
    // Same endpoints as the oklch pins above, expressed in a and b rather than chroma and hue —
    // at a=b=0 the two notations describe the same axis.
    expect(hex('oklab(0 0 0)')).toBe('#000000');
    expect(hex('oklab(1 0 0)')).toBe('#ffffff');
  });

  it('rejects an oklab with a channel that is not a number', () => {
    expect(hex('oklab(none 0.1 0.1)')).toBeNull();
  });

  it('reads rgb() with percentage channels, not only integer ones', () => {
    expect(hex('rgb(20%, 40%, 60%)')).toBe('#336699');
  });

  it('rejects rgb() with a channel that does not parse as a number', () => {
    expect(hex('rgb(84, banana, 212)')).toBeNull();
  });

  it('reads oklch with a percentage chroma, per the CSS Color 4 definition', () => {
    // 0.4 is the reference chroma the percentage is relative to; the exact resulting hue is not
    // the point here (the oklch pins above already cover the arithmetic) — only that a percentage
    // chroma is accepted and still produces a real colour rather than being dropped.
    expect(hex('oklch(50% 50% 260)')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('rejects hsl() with a channel that does not parse as a number', () => {
    expect(hex('hsl(not-a-hue, 50%, 50%)')).toBeNull();
  });

  it('rejects an out-of-range hex length that is not one of the four valid ones', () => {
    // 5 digits is neither the 3/4-digit short form nor the 6/8-digit long form.
    expect(hex('#12345')).toBeNull();
  });

  it('rejects a 3-digit-length hex containing a non-hex character', () => {
    expect(hex('#abz')).toBeNull();
  });

  it('rejects a 6-digit-length hex containing a non-hex character', () => {
    expect(hex('#abcxyz')).toBeNull();
  });

  it('walks every sector of the hue wheel, not only the ones that land on hp<1', () => {
    // Every hue above lands in the SAME first branch of the hp cascade (h=0 → hp=0), so between
    // them the three existing tests never touch hp>=1. These six sit at the midpoint of each
    // 60°-wide sector so every branch of the cascade — not just its first — gets a real colour
    // through it, at full saturation and half lightness where the arithmetic is exact.
    expect(hex('hsl(30, 100%, 50%)')).toBe('#ff8000');
    expect(hex('hsl(90, 100%, 50%)')).toBe('#80ff00');
    expect(hex('hsl(150, 100%, 50%)')).toBe('#00ff80');
    expect(hex('hsl(210, 100%, 50%)')).toBe('#0080ff');
    expect(hex('hsl(270, 100%, 50%)')).toBe('#8000ff');
    expect(hex('hsl(330, 100%, 50%)')).toBe('#ff0080');
  });
});

describe('extractColorFrequency', () => {
  it('counts every literal and ranks by how often it appears', () => {
    const css = `
      .a { color: #5469d4; }
      .b { background: #ffffff; border-color: #5469d4; }
      .c { color: rgb(84 105 212); }
    `;
    const frequency = extractColorFrequency(css);

    // The rgb() form is the same colour as the hex, so it counts toward the same entry.
    expect(frequency[0]).toEqual({ hex: '#5469d4', count: 3 });
    expect(frequency[1]).toEqual({ hex: '#ffffff', count: 1 });
  });

  it('finds nothing in a stylesheet with no colours', () => {
    expect(extractColorFrequency('.a { display: flex; }')).toEqual([]);
  });

  it('skips a token that matches the colour pattern but does not parse as one', () => {
    // `rgb(84)` is shaped like a colour function and matched by the token regex, but it has too
    // few channels to parse — the loop has to skip it and keep counting the real ones.
    const css = `.a { color: rgb(84); } .b { color: #5469d4; }`;
    expect(extractColorFrequency(css)).toEqual([{ hex: '#5469d4', count: 1 }]);
  });
});

describe('extractDeclaredBrandColors', () => {
  it('reads the custom properties that name a brand', () => {
    const css = `:root { --brand-primary: #5469d4; --color-accent: #0fa39a; }`;

    expect(extractDeclaredBrandColors(css)).toEqual([
      { name: '--brand-primary', hex: '#5469d4' },
      { name: '--color-accent', hex: '#0fa39a' },
    ]);
  });

  it('ignores a design system ramp, which is colours but is not the brand', () => {
    // A full ramp would drown the two or three properties that actually mean something.
    const css = `:root { --color-gray-200: #e5e7eb; --spacing-4: 1rem; }`;
    expect(extractDeclaredBrandColors(css)).toEqual([]);
  });

  it('ignores brand-shaped names that are known to be something else', () => {
    const css = `:root { --primary-foreground: #ffffff; --accent-hover: #333333; }`;
    expect(extractDeclaredBrandColors(css)).toEqual([]);
  });

  it('deduplicates a colour declared under two names', () => {
    const css = `:root { --brand: #5469d4; --color-primary: #5469d4; }`;
    expect(extractDeclaredBrandColors(css)).toHaveLength(1);
  });

  it('reads a brand declared in oklch, not only in hex', () => {
    const css = `:root { --brand-primary: oklch(0.623 0.214 259.815); }`;
    expect(extractDeclaredBrandColors(css)).toEqual([{ name: '--brand-primary', hex: '#2b7fff' }]);
  });

  it('ignores a brand-named property whose value has no colour token in it at all', () => {
    // `--brand-primary` names a brand, but "bold" is not a colour of any notation — the property
    // has to be skipped rather than reported with nothing.
    const css = `:root { --brand-primary: bold; }`;
    expect(extractDeclaredBrandColors(css)).toEqual([]);
  });

  it('ignores a brand-named property whose value looks like a colour but does not parse as one', () => {
    // #12345 matches the colour-token regex (3–8 hex digits) but is not a valid hex length, so it
    // has to be dropped rather than reported as a declared brand colour.
    const css = `:root { --brand-primary: #12345; }`;
    expect(extractDeclaredBrandColors(css)).toEqual([]);
  });
});
