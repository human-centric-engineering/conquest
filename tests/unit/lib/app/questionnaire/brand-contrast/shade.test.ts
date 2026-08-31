/**
 * Unit tests: the tint/shade solver.
 *
 * This module is the load-bearing arithmetic of the contrast optimiser — every colour an admin is
 * offered comes out of it — so the tests are about the two properties that make an offer honest:
 *
 *  1. **It is still their colour.** The ramp preserves hue, which is the whole promise the feature
 *     makes. The regression that motivates the first block is real and was measured, not imagined:
 *     an HSL-lightness implementation turned a cream page ground into a saturated brown, because
 *     HSL saturation is normalised by lightness and a pale tint reports S = 1.0.
 *  2. **It is nearest.** A solver that returns a working-but-distant shade would technically pass
 *     while proposing a rebrand, so the alternating outward walk is pinned directly.
 *
 * The multi-constraint case is tested on its own because it is the one a binary search could not
 * have handled, and it is the accent's actual situation: one colour, two grounds.
 *
 * @see lib/app/questionnaire/brand-contrast/shade.ts
 */

import { describe, it, expect } from 'vitest';

import { nearestReadableShade, shadeOf } from '@/lib/app/questionnaire/brand-contrast/shade';
import { contrastRatio } from '@/lib/app/questionnaire/theming';
import { parseHex } from '@/lib/app/questionnaire/brand-import/color';

/** Channel ratios, which is what "same hue" means for an sRGB tint/shade ramp. */
function hueSignature(hex: string): [number, number] {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`unreadable: ${hex}`);
  const max = Math.max(rgb.r, rgb.g, rgb.b) || 1;
  return [rgb.r / max, rgb.g / max];
}

describe('shadeOf', () => {
  it('returns the colour untouched at zero', () => {
    expect(shadeOf('#f1c232', 0)).toBe('#f1c232');
  });

  it('darkens toward black for a negative amount and lightens toward white for a positive one', () => {
    // The direction the whole module's sign convention rests on. An early draft read the mix weight
    // backwards, so a 1% darkening returned near-black — visible here as a swapped pair.
    expect(shadeOf('#808080', -0.5)).toBe('#404040');
    expect(shadeOf('#808080', 0.5)).toBe('#c0c0c0');
  });

  it('reaches pure black and pure white at the ends', () => {
    expect(shadeOf('#f1c232', -1)).toBe('#000000');
    expect(shadeOf('#f1c232', 1)).toBe('#ffffff');
  });

  it('clamps beyond the ends rather than producing a nonsense colour', () => {
    expect(shadeOf('#f1c232', -4)).toBe('#000000');
    expect(shadeOf('#f1c232', 4)).toBe('#ffffff');
  });

  it('returns null for a colour it cannot read', () => {
    expect(shadeOf('teal', -0.2)).toBeNull();
  });

  it('keeps the hue when darkening — scaling every channel preserves their ratios', () => {
    const shaded = shadeOf('#f1c232', -0.4);
    expect(shaded).not.toBeNull();
    const [r, g] = hueSignature('#f1c232');
    const [sr, sg] = hueSignature(shaded as string);
    expect(sr).toBeCloseTo(r, 2);
    expect(sg).toBeCloseTo(g, 2);
  });
});

describe('nearestReadableShade', () => {
  it('returns the colour itself, at amount zero, when it already reads', () => {
    // Not a repair. The audit relies on this to tell "the other half of the pair is the problem"
    // apart from "this colour needs to move".
    const shade = nearestReadableShade('#1a1a1a', [{ against: '#ffffff', min: 4.5 }]);
    expect(shade?.amount).toBe(0);
    expect(shade?.hex).toBe('#1a1a1a');
  });

  it('finds a shade that actually clears the target', () => {
    const shade = nearestReadableShade('#9a9a8f', [{ against: '#fffcf5', min: 4.5 }]);
    expect(shade).not.toBeNull();
    expect(contrastRatio((shade as { hex: string }).hex, '#fffcf5')).toBeGreaterThanOrEqual(4.5);
  });

  it('does not turn a pale cream into a saturated brown', () => {
    // The regression this module was rewritten for. `#fffcf5` reports HSL saturation 1.0 because
    // saturation is normalised by lightness, so darkening it at "constant saturation" walked it
    // down a fully-saturated ramp and produced `#422f00`. A shade of a near-neutral cream must
    // stay a near-neutral.
    const shade = nearestReadableShade('#fffcf5', [{ against: '#9a9a8f', min: 4.5 }]);
    expect(shade).not.toBeNull();
    const rgb = parseHex((shade as { hex: string }).hex);
    const spread = Math.max(rgb!.r, rgb!.g, rgb!.b) - Math.min(rgb!.r, rgb!.g, rgb!.b);
    expect(spread).toBeLessThan(20);
  });

  it('returns the NEAREST shade, not merely a working one', () => {
    // Nothing closer to the original may also satisfy the constraint, or the solver is proposing a
    // bigger change to the brand than the problem required.
    const shade = nearestReadableShade('#9a9a8f', [{ against: '#fffcf5', min: 4.5 }]);
    const { amount } = shade as { amount: number };
    for (let closer = 0; Math.abs(closer) < Math.abs(amount); closer += 0.005) {
      for (const candidate of [shadeOf('#9a9a8f', -closer), shadeOf('#9a9a8f', closer)]) {
        const ratio = candidate ? contrastRatio(candidate, '#fffcf5') : null;
        expect(ratio === null || ratio < 4.5).toBe(true);
      }
    }
  });

  it('walks both ways, so a pale colour is not always darkened to near-black', () => {
    // A mid-grey button whose derived label is dark reads better when the button gets LIGHTER. A
    // solver that scanned one direction to its end first would have darkened it instead.
    const shade = nearestReadableShade('#7a7a7a', [{ against: '#1a1a1a', min: 4.5 }]);
    expect((shade as { amount: number }).amount).toBeGreaterThan(0);
  });

  it('satisfies two constraints at once — the accent on both grounds', () => {
    // The case that rules out a binary search: there is no single direction to walk when a colour
    // is rendered on a near-white and a near-black at the same time.
    const shade = nearestReadableShade('#00e5ff', [
      { against: '#ffffff', min: 3 },
      { against: '#0a0a0a', min: 3 },
    ]);
    expect(shade).not.toBeNull();
    const { hex } = shade as { hex: string };
    expect(contrastRatio(hex, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(hex, '#0a0a0a')).toBeGreaterThanOrEqual(3);
  });

  it('returns null when no shade satisfies every constraint', () => {
    // Real and reportable: 4.5:1 against both a near-white and a near-black is unreachable for
    // essentially any colour. Saying so beats fixing one mode by breaking the other.
    expect(
      nearestReadableShade('#00e5ff', [
        { against: '#ffffff', min: 4.5 },
        { against: '#0a0a0a', min: 4.5 },
      ])
    ).toBeNull();
  });

  it('treats an unreadable counterpart as unsatisfiable rather than satisfied', () => {
    // Otherwise a repair would be proposed on the strength of a comparison that never happened.
    expect(nearestReadableShade('#f1c232', [{ against: 'not-a-colour', min: 4.5 }])).toBeNull();
  });

  it('returns null when there is nothing to satisfy', () => {
    expect(nearestReadableShade('#f1c232', [])).toBeNull();
  });
});
