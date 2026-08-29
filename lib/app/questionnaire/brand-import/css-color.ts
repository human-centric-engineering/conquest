/**
 * Brand import — reading colours out of CSS.
 *
 * A website states its brand colours in its stylesheets, and it states them in whatever notation
 * was fashionable when the site was built. Handling only `#rrggbb` would work on a 2015 site and
 * find nothing on a 2025 one: Tailwind 4 emits `oklch()` for its entire palette, and a modern
 * design system publishes its brand as custom properties in that space.
 *
 * So this parses the five notations that actually appear — hex (3/4/6/8 digits), `rgb()`, `hsl()`,
 * `oklch()` and `oklab()` — and converts them all to the `#rrggbb` the theme columns store. The
 * OKLab conversion is written out rather than pulled from a colour library: it is thirty lines of
 * arithmetic against a published matrix, and a dependency here would be carried by every fork of
 * this repo for one function.
 *
 * ## Two ways to read a stylesheet
 *
 * `extractDeclaredBrandColors` reads what the site SAYS about itself — a custom property named
 * `--brand-primary` is a statement of intent, not an accident, and is worth more than any
 * frequency count. `extractColorFrequency` reads what it DOES: every colour literal, counted. The
 * first is high confidence and usually finds two or three colours; the second is low confidence and
 * finds forty, most of them greys. The harvest uses both, weighted accordingly.
 *
 * Pure: no network, no DOM, no dependencies.
 */

import { toHex, type Rgb } from '@/lib/app/questionnaire/brand-import/color';

/**
 * Colour literals in any of the notations we read.
 *
 * Function forms are matched without nesting (`[^()]*`), which deliberately skips
 * `color-mix(in srgb, …)` and relative-colour syntax: those describe a colour in terms of another
 * one, so the interesting value is the inner literal, and that is matched on its own anyway.
 */
const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(\s*[^()]*\)/gi;

/** `--name: value` declarations. Stops at `;` or the end of the block. */
const CUSTOM_PROPERTY = /--([a-z0-9-]+)\s*:\s*([^;}]+)/gi;

/**
 * Custom-property names that indicate a brand statement rather than an implementation detail.
 *
 * Deliberately narrow. `--color-gray-200` is a colour and is not the brand; `--brand-primary`,
 * `--color-primary` and `--accent` are. Matching every property containing "color" would drown the
 * two or three that mean something in a design system's full ramp.
 */
const BRAND_PROPERTY_NAME = /(?:^|-)(?:brand|primary|accent|theme|cta)(?:-|$)/;

/** Property names that look brand-ish but are known to be something else. */
const NOT_A_BRAND_PROPERTY = /(?:foreground|contrast|muted|disabled|hover|border|shadow|ring)/;

/**
 * Parse one CSS colour token to channels, or null when it is not a colour we read.
 *
 * Alpha is parsed and then DISCARDED rather than composited onto an assumed background: the theme
 * columns store opaque hexes, and compositing `rgba(0,0,0,.06)` onto a white we guessed would
 * invent a light grey that appears nowhere in the design.
 */
export function parseCssColor(token: string): Rgb | null {
  const value = token.trim().toLowerCase();

  if (value.startsWith('#')) return parseHexToken(value);

  const call = /^([a-z]+)\(\s*(.*?)\s*\)$/.exec(value);
  if (!call) return null;

  const [, fn, argsRaw] = call;
  // CSS accepts both the legacy comma form and the modern space form, plus a `/ alpha` tail.
  const args = argsRaw
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (args.length < 3) return null;

  switch (fn) {
    case 'rgb':
    case 'rgba':
      return parseRgbArgs(args);
    case 'hsl':
    case 'hsla':
      return hslToRgb(number(args[0]), percentage(args[1]), percentage(args[2]));
    case 'oklch':
      return oklabToRgb(
        lightness(args[0]),
        chromaValue(args[1]) * Math.cos((number(args[2]) * Math.PI) / 180),
        chromaValue(args[1]) * Math.sin((number(args[2]) * Math.PI) / 180)
      );
    case 'oklab':
      return oklabToRgb(lightness(args[0]), chromaValue(args[1]), chromaValue(args[2]));
    default:
      return null;
  }
}

/** Every colour literal in a stylesheet, as hexes with the number of times each appeared. */
export function extractColorFrequency(css: string): { hex: string; count: number }[] {
  const counts = new Map<string, number>();

  for (const match of css.matchAll(COLOR_TOKEN)) {
    const rgb = parseCssColor(match[0]);
    if (!rgb) continue;
    const hex = toHex(rgb);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The colours a stylesheet DECLARES as its brand, via custom properties.
 *
 * Returns the property name alongside the colour, because the name is the evidence: showing an
 * admin "#5469d4 — the site declares this as --brand-primary" is a different claim from "#5469d4 —
 * this colour appears a lot", and they should be able to tell which they are looking at.
 */
export function extractDeclaredBrandColors(css: string): { name: string; hex: string }[] {
  const found: { name: string; hex: string }[] = [];
  const seen = new Set<string>();

  for (const match of css.matchAll(CUSTOM_PROPERTY)) {
    const name = match[1].toLowerCase();
    if (!BRAND_PROPERTY_NAME.test(name) || NOT_A_BRAND_PROPERTY.test(name)) continue;

    // A custom property's value may itself be a bare triple (`--brand: 84 105 212`) in the
    // Tailwind-3 convention, but far more often it is a literal; take the first colour in it.
    const token = COLOR_TOKEN.exec(match[2]);
    COLOR_TOKEN.lastIndex = 0;
    if (!token) continue;

    const rgb = parseCssColor(token[0]);
    if (!rgb) continue;

    const hex = toHex(rgb);
    if (seen.has(hex)) continue;
    seen.add(hex);
    found.push({ name: `--${name}`, hex });
  }

  return found;
}

function parseHexToken(value: string): Rgb | null {
  const hex = value.slice(1);
  // 4 and 8 digits carry an alpha we drop; 3 and 6 are the opaque forms.
  if (hex.length === 3 || hex.length === 4) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

function parseRgbArgs(args: string[]): Rgb | null {
  const channel = (raw: string): number =>
    raw.endsWith('%') ? (percentage(raw) * 255) / 100 : number(raw);
  const rgb = { r: channel(args[0]), g: channel(args[1]), b: channel(args[2]) };
  return Number.isFinite(rgb.r) && Number.isFinite(rgb.g) && Number.isFinite(rgb.b) ? rgb : null;
}

function number(raw: string): number {
  return Number.parseFloat(raw);
}

function percentage(raw: string): number {
  return Number.parseFloat(raw);
}

/** OKLab lightness: `0.62` and `62%` are the same value, and both appear in the wild. */
function lightness(raw: string): number {
  const value = Number.parseFloat(raw);
  return raw.trim().endsWith('%') ? value / 100 : value;
}

/** OKLab chroma / a / b. A percentage here is relative to 0.4, per the CSS Color 4 definition. */
function chromaValue(raw: string): number {
  const value = Number.parseFloat(raw);
  return raw.trim().endsWith('%') ? (value / 100) * 0.4 : value;
}

function hslToRgb(h: number, s: number, l: number): Rgb | null {
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = lig - c / 2;

  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];

  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/**
 * OKLab → sRGB, via the published LMS matrices and the sRGB transfer function.
 *
 * Written out rather than taken from a colour library: it is one matrix multiply, three cubes and a
 * gamma curve, and this repo is a starter template whose forks would all carry the dependency.
 * Values are Björn Ottosson's, as adopted by CSS Color 4.
 */
function oklabToRgb(L: number, a: number, b: number): Rgb | null {
  if (!Number.isFinite(L) || !Number.isFinite(a) || !Number.isFinite(b)) return null;

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const linear = {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };

  return {
    r: gamma(linear.r) * 255,
    g: gamma(linear.g) * 255,
    b: gamma(linear.b) * 255,
  };
}

/** Linear-light → sRGB. Clamped: a wide-gamut oklch can land outside sRGB, and the columns are sRGB. */
function gamma(channel: number): number {
  const c = Math.max(0, Math.min(1, channel));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
