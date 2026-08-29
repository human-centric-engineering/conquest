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
});
