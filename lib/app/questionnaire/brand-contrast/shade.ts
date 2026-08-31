/**
 * Contrast optimiser — finding a shade of a colour that reads.
 *
 * The whole feature turns on one idea: an admin handed a brand colour does not want it REPLACED
 * when it fails contrast, they want the nearest version of it that passes. So every repair holds
 * the colour's hue and moves it only along the tint/shade axis — toward black, or toward white.
 *
 * ## Why a tint/shade ramp and not HSL lightness
 *
 * The obvious implementation converts to HSL and scans the L axis at fixed hue and saturation. It
 * is wrong, and wrong in a way that only shows up on exactly the colours this feature exists for.
 *
 * HSL saturation is normalised by lightness, so a pale tinted neutral — a cream page ground like
 * `#fffcf5`, which is what half of real brands use — has **S = 1.0**. Darkening it at constant
 * saturation walks it down a fully-saturated ramp and lands on `#422f00`, a saturated brown. That
 * is not a shade of the cream; it is a different colour, proposed under the claim that we had kept
 * theirs. (Measured, not theorised: it is what the first draft of this module actually returned.)
 *
 * Mixing toward black or white in sRGB is the painter's definition of a shade and a tint, and it
 * behaves: scaling every channel by the same factor preserves their ratios exactly, so the hue
 * survives and the saturation decays the way it has to — you cannot have a vivid near-black.
 *
 * ## Why a scan rather than a binary search
 *
 * Two reasons, and the second is the one that rules it out entirely:
 *
 *  1. **Contrast against a fixed counterpart is not monotonic along the ramp.** Darkening a
 *     mid-tone raises contrast against white and lowers it against black; a search that assumes a
 *     direction walks the wrong way half the time.
 *  2. **A colour can have to satisfy more than one constraint.** The accent is emitted ONCE and
 *     rendered on both grounds, so its repair must clear both at the same time. There is no single
 *     direction for a binary search to take.
 *
 * A linear scan has neither problem, provably returns the nearest satisfying shade, and costs ~200
 * WCAG ratio computations — free at the scale this runs at.
 *
 * Pure: no Prisma / Next / React. `contrastRatio` comes from the theming module rather than being
 * re-derived, so the number shown here and the warning already on the form are two readings of one
 * formula.
 */

import { contrastRatio } from '@/lib/app/questionnaire/theming';
import { mix } from '@/lib/app/questionnaire/brand-import/color';

/** Pure black and pure white — the two ends every tint/shade ramp runs between. */
const BLACK = '#000000';
const WHITE = '#ffffff';

/**
 * Step along the ramp.
 *
 * 0.005 is finer than a hex can encode at either end, so the "nearest" shade returned is nearest to
 * the precision the answer is expressed in. 400 steps across the full range.
 */
const RAMP_STEP = 0.005;

/**
 * A point on `base`'s tint/shade ramp.
 *
 * `amount` is signed and that is deliberate: it carries BOTH how far the colour moved and which way
 * it went, so no consumer has to re-derive "did this get lighter or darker" from two hexes — which
 * is exactly the comparison that is easy to get wrong.
 */
export interface Shade {
  hex: string;
  /** −1 → pure black, 0 → the colour untouched, +1 → pure white. */
  amount: number;
}

/**
 * `base` mixed toward black (negative `amount`) or white (positive), in sRGB.
 *
 * Returns null only when `base` cannot be read as a colour.
 */
export function shadeOf(base: string, amount: number): string | null {
  const t = Math.max(-1, Math.min(1, amount));
  if (t === 0) return mix(base, base, 0);
  // `mix(hex, toward, weight)` weights the TARGET — `weight` is how much of `toward` is stirred in,
  // not how much of `base` survives. Read the other way round it inverts the whole ramp: a 1%
  // darkening becomes 99% black, which is what the first draft actually returned.
  return t < 0 ? mix(base, BLACK, -t) : mix(base, WHITE, t);
}

/** One thing a shade has to read against. */
export interface ShadeConstraint {
  /** The colour it will be seen on (or that will be seen on it). */
  against: string;
  /** The WCAG ratio it must reach. */
  min: number;
}

/**
 * The nearest shade or tint of `base` that satisfies every constraint.
 *
 * Returns `amount: 0` when the colour already passes, and `null` when no point on the ramp does.
 * Null is a real answer rather than a failure: an accent with no version of itself that clears both
 * a near-white and a near-black ground genuinely has none, and saying so beats proposing one that
 * fixes one mode by breaking the other.
 */
export function nearestReadableShade(base: string, constraints: ShadeConstraint[]): Shade | null {
  if (constraints.length === 0) return null;

  const passes = (hex: string): boolean =>
    constraints.every(({ against, min }) => {
      const ratio = contrastRatio(hex, against);
      // An unreadable counterpart can be neither satisfied nor violated. Treating it as satisfied
      // would let a repair be proposed on the strength of a comparison that never happened.
      return ratio !== null && ratio >= min;
    });

  const start = shadeOf(base, 0);
  if (!start) return null;
  if (passes(start)) return { hex: start, amount: 0 };

  // Walk outward from the colour itself, alternating darker and lighter, so the FIRST hit is the
  // nearest on either side. Alternating matters: scanning one direction to its end first would
  // always prefer that direction, and on a pale brand that means proposing near-black when a small
  // deepening would have done.
  for (let step = RAMP_STEP; step <= 1; step += RAMP_STEP) {
    for (const amount of [-step, step]) {
      const hex = shadeOf(base, amount);
      if (hex && passes(hex)) return { hex, amount };
    }
  }

  return null;
}
