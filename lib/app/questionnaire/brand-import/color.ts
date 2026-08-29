/**
 * Brand import — colour arithmetic.
 *
 * The small numeric helpers the palette extractor and (from the URL harvest) the stylesheet reader
 * both need: parse a colour to channels, format it back as the `#rrggbb` the theme columns store,
 * decide whether it carries enough chroma to read as a brand colour, and measure how far apart two
 * colours look.
 *
 * Deliberately NOT reusing `theming/theme.ts`'s internals: `channels()` and `relativeLuminance()`
 * there are private, and widening them to exports would make a rendering module's private
 * arithmetic part of the theming contract for the sake of one caller. `contrastRatio` — the piece
 * that IS exported and IS the shared judgement — is used directly by `contrast.ts`.
 *
 * Pure: no dependencies at all.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` / `#rrggbb` → channels, or null when it is neither. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    if (!/^[0-9a-fA-F]{3}$/.test(hex)) return null;
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length === 6) {
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * Channels → `#rrggbb`, lowercase.
 *
 * Always six digits, never the three-digit short form: the stored value is compared against the
 * candidate list by string equality when we check that the model did not invent a colour, and
 * `#fff` vs `#ffffff` would fail that check for a colour that was genuinely on the page.
 */
export function toHex({ r, g, b }: Rgb): string {
  const channel = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Chroma: how far the colour is from grey, 0–1.
 *
 * The plain max-minus-min spread rather than a perceptual saturation, because the only decision it
 * feeds is a coarse one — "could this be a brand colour, or is it part of the page's ground?" — and
 * a perceptual model would add a colour-space conversion to answer the same yes/no.
 */
export function chroma(rgb: Rgb): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return (max - min) / 255;
}

/**
 * Below this a colour reads as part of the page's ground rather than its brand.
 *
 * 0.12 (≈31 levels of spread) admits the tinted neutrals real brands actually use — a warm cream,
 * a blue-grey slate — while excluding the compression noise around a white background, which is
 * what a tighter threshold would start promoting to "brand colour".
 */
export const NEUTRAL_CHROMA_THRESHOLD = 0.12;

export function isNeutral(rgb: Rgb): boolean {
  return chroma(rgb) < NEUTRAL_CHROMA_THRESHOLD;
}

/**
 * Perceptual-ish distance between two colours, 0–~255.
 *
 * "Redmean" — a cheap approximation that weights the channels by where the colour sits on the red
 * axis. Used only to merge buckets that are the same colour to a human (a logo's antialiased edge
 * produces a dozen near-identical blues), so an approximation is the right tool: the alternative is
 * a full CIELAB conversion per pixel bucket to make the same merge decision.
 */
export function distance(a: Rgb, b: Rgb): number {
  const rMean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}
