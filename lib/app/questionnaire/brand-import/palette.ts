/**
 * Brand import — measure the colours actually present in an image.
 *
 * The deterministic half of the feature, and the half everything else is built on. Given a
 * screenshot or a logo, it returns the colours that are really there, ranked by how much of the
 * image they cover. No model is involved and none can be: this is the ground truth the role
 * assigner is later constrained to choose from, so if a hex comes out of here it was on the page.
 *
 * ## Why buckets, then a merge
 *
 * Two passes rather than a clustering algorithm. A coarse 5-bit-per-channel bucket collapses the
 * antialiasing and JPEG noise that would otherwise make every logo edge its own colour; the merge
 * pass then folds buckets that are still the same colour to a human — a logo's blue typically
 * spans several adjacent buckets — into the heaviest one. k-means would do a nicer job of the
 * second step and would need a k we have no way to choose: a two-colour wordmark and a photographic
 * hero want very different values, and guessing wrong silently splits or merges a brand colour.
 *
 * ## Transparency and neutrals
 *
 * Transparent pixels are skipped entirely — a logo PNG is mostly transparent, and counting its
 * empty margin would rank "nothing" as the brand's primary colour.
 *
 * Near-neutral colours are **kept and flagged**, not dropped. They are the answer for `canvasColor`
 * and `inkColor`, which are near-neutral on almost every real page. Filtering them out here as
 * "not brand colours" is the obvious first implementation and it quietly makes the two most
 * structurally important fields unfillable.
 */

import sharp from 'sharp';

import { MAX_INPUT_PIXELS } from '@/lib/app/questionnaire/theming/brand-image';
import type { ColorCandidate } from '@/lib/app/questionnaire/brand-import/result';
import {
  distance,
  isNeutral,
  parseHex,
  toHex,
  type Rgb,
} from '@/lib/app/questionnaire/brand-import/color';

/**
 * Longest edge the image is scaled to before sampling.
 *
 * 128px is ~16k pixels — enough that a logo occupying 2% of a screenshot still contributes a few
 * hundred samples, and small enough that the whole pass is sub-millisecond. Sampling at full
 * resolution would change none of the rankings and would decode a multi-megapixel buffer to do it.
 */
const SAMPLE_EDGE = 128;

/** Alpha below this is treated as absent. Half-opaque pixels are a logo's antialiased edge. */
const MIN_ALPHA = 128;

/**
 * Low bits DROPPED per channel when bucketing: 3 dropped leaves 5 bits, i.e. 32 levels per channel
 * and 32768 buckets. Coarse enough to collapse antialiasing, fine enough that two brand colours
 * never share a bucket.
 */
const BUCKET_SHIFT = 3;

/**
 * Redmean distance below which two buckets are the same colour.
 *
 * 48 merges the shades of one brand blue without merging a brand blue into a brand teal. Tuned
 * against the failure that matters: over-merging loses a real second accent, which the admin
 * cannot recover; under-merging shows them two swatches of nearly the same colour, which they can.
 */
const MERGE_DISTANCE = 48;

/** Colours covering less than this fraction of the sampled pixels are noise, not brand. */
const MIN_SHARE = 0.002;

/** Candidates returned. Beyond a dozen the list stops being something an admin can scan. */
const DEFAULT_MAX_CANDIDATES = 12;

export interface PaletteOptions {
  /** Cap on returned candidates. Defaults to {@link DEFAULT_MAX_CANDIDATES}. */
  max?: number;
}

interface Bucket {
  sum: Rgb;
  count: number;
}

/**
 * Measure an image's palette.
 *
 * Returns `[]` for anything sharp cannot decode rather than throwing: a brand import runs over
 * whatever a website served, and one unreadable favicon must not fail the whole import. The caller
 * distinguishes "no colours" from "no image" by whether it had bytes at all.
 */
export async function extractPalette(
  buffer: Buffer,
  options: PaletteOptions = {}
): Promise<ColorCandidate[]> {
  const max = options.max ?? DEFAULT_MAX_CANDIDATES;

  let raw: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    raw = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return [];
  }

  const { data } = raw;
  const buckets = new Map<number, Bucket>();
  let counted = 0;

  // Four channels guaranteed by `ensureAlpha()`, so the stride is fixed.
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < MIN_ALPHA) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key =
      ((r >> BUCKET_SHIFT) << (2 * (8 - BUCKET_SHIFT))) |
      ((g >> BUCKET_SHIFT) << (8 - BUCKET_SHIFT)) |
      (b >> BUCKET_SHIFT);

    const existing = buckets.get(key);
    if (existing) {
      existing.sum.r += r;
      existing.sum.g += g;
      existing.sum.b += b;
      existing.count += 1;
    } else {
      buckets.set(key, { sum: { r, g, b }, count: 1 });
    }
    counted += 1;
  }

  if (counted === 0) return [];

  // Heaviest first, so the merge pass always folds a lighter bucket into a heavier one and the
  // surviving colour is the one more of the image actually is.
  const ordered = [...buckets.values()]
    .map((bucket) => ({
      rgb: {
        r: bucket.sum.r / bucket.count,
        g: bucket.sum.g / bucket.count,
        b: bucket.sum.b / bucket.count,
      },
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const merged: { rgb: Rgb; count: number }[] = [];
  for (const entry of ordered) {
    const near = merged.find((accepted) => distance(accepted.rgb, entry.rgb) < MERGE_DISTANCE);
    if (near) {
      near.count += entry.count;
      continue;
    }
    merged.push({ ...entry });
  }

  return merged
    .map((entry) => ({
      hex: toHex(entry.rgb),
      share: entry.count / counted,
      neutral: isNeutral(entry.rgb),
    }))
    .filter((candidate) => candidate.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, max);
}

/**
 * Fold several palettes into one ranked list.
 *
 * The URL harvest measures more than one image — a logo and a mark, say — and their palettes have
 * to become a single candidate list before role assignment. `weights` lets a caller say the logo
 * matters more than the favicon: a logo IS the brand, while a favicon is often a flat generic
 * square, so ranking them by raw pixel share would let the wrong image win on area alone.
 */
export function mergePalettes(
  sources: { candidates: ColorCandidate[]; weight: number }[],
  max = DEFAULT_MAX_CANDIDATES
): ColorCandidate[] {
  const totalWeight = sources.reduce((sum, source) => sum + source.weight, 0);
  if (totalWeight <= 0) return [];

  const merged: { rgb: Rgb; hex: string; share: number; neutral: boolean }[] = [];

  for (const source of sources) {
    for (const candidate of source.candidates) {
      const rgb = parseHex(candidate.hex);
      if (!rgb) continue;
      const weighted = (candidate.share * source.weight) / totalWeight;

      const near = merged.find((accepted) => distance(accepted.rgb, rgb) < MERGE_DISTANCE);
      if (near) {
        near.share += weighted;
        continue;
      }
      merged.push({ rgb, hex: candidate.hex, share: weighted, neutral: candidate.neutral });
    }
  }

  return merged
    .map(({ hex, share, neutral }) => ({ hex, share, neutral }))
    .sort((a, b) => b.share - a.share)
    .slice(0, max);
}
