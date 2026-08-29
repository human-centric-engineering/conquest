/**
 * Unit tests: completing the four ground fields.
 *
 * These exist because of a real import. A brand whose canvas is a deep purple (#691b9a) produced a
 * light panel and a dark panel that were the SAME purple: `resolveTheme` carries an already-dark
 * canvas across to dark mode unchanged — a sensible default for a colour an admin typed, and the
 * wrong one for an import, because the admin is then shown a light/dark comparison in which
 * nothing differs and has no way to tell it is broken rather than intentional.
 */

import { describe, it, expect } from 'vitest';

import {
  MIN_GROUND_SEPARATION,
  completeGrounds,
  darkGroundFor,
  groundsAreDistinct,
} from '@/lib/app/questionnaire/brand-import/ground';
import {
  MIN_CONTRAST_RATIO,
  contrastRatio,
  darkenForDarkMode,
} from '@/lib/app/questionnaire/theming';
import type { ProposedField } from '@/lib/app/questionnaire/brand-import/result';

const measured = (value: string): ProposedField => ({
  value,
  confidence: 'high',
  source: 'read from the site',
});

/** The colour from the import that prompted all of this. */
const DEEP_PURPLE = '#691b9a';

describe('darkGroundFor', () => {
  it('deepens an already-dark brand canvas instead of leaving it alone', () => {
    const dark = darkGroundFor(DEEP_PURPLE);

    expect(dark).not.toBeNull();
    expect(dark).not.toBe(DEEP_PURPLE);
    expect(groundsAreDistinct(DEEP_PURPLE, dark as string)).toBe(true);
  });

  it('keeps the hue, so a purple brand does not become a black rectangle', () => {
    // The reason the resolver declines to darken a dark canvas at all. Mixing toward near-black
    // rather than tinting over it is what keeps the brand recognisable.
    const dark = darkGroundFor(DEEP_PURPLE) as string;
    const [, r, g, b] = /^#(..)(..)(..)$/.exec(dark) as RegExpExecArray;

    expect(parseInt(b, 16)).toBeGreaterThan(parseInt(g, 16));
    expect(parseInt(r, 16)).toBeGreaterThan(parseInt(g, 16));
  });

  it('leaves a light canvas to the platform derivation, which is already right', () => {
    // A cream paper stock has a good dark counterpart already — the hue as a tint over near-black.
    expect(darkGroundFor('#fffcf5')).toBe(darkenForDarkMode('#fffcf5'));
  });

  it('returns null for a colour it cannot read', () => {
    expect(darkGroundFor('not a colour')).toBeNull();
  });
});

describe('groundsAreDistinct', () => {
  it('rejects a colour against itself', () => {
    expect(groundsAreDistinct(DEEP_PURPLE, DEEP_PURPLE)).toBe(false);
  });

  it('accepts two grounds far enough apart to read as different modes', () => {
    expect(groundsAreDistinct('#ffffff', '#0a0a0a')).toBe(true);
  });

  it('sits well below the text threshold — these two never appear together', () => {
    // They need to be distinguishable side by side, not legible against each other.
    expect(MIN_GROUND_SEPARATION).toBeLessThan(MIN_CONTRAST_RATIO);
  });
});

describe('completeGrounds', () => {
  it('does nothing without a canvas to build from', () => {
    const fields = { ctaColor: measured('#5469d4') };
    expect(completeGrounds(fields)).toEqual(fields);
  });

  it('fills all four ground fields from a canvas alone', () => {
    const out = completeGrounds({ canvasColor: measured(DEEP_PURPLE) });

    expect(out.canvasColor?.value).toBe(DEEP_PURPLE);
    expect(out.canvasColorDark?.value).toBeDefined();
    expect(out.inkColor?.value).toBeDefined();
    expect(out.inkColorDark?.value).toBeDefined();
  });

  it('produces a readable pair in BOTH modes', () => {
    const out = completeGrounds({ canvasColor: measured(DEEP_PURPLE) });

    for (const [ground, ink] of [
      [out.canvasColor?.value, out.inkColor?.value],
      [out.canvasColorDark?.value, out.inkColorDark?.value],
    ] as const) {
      expect(contrastRatio(ground as string, ink as string)).toBeGreaterThanOrEqual(
        MIN_CONTRAST_RATIO
      );
    }
  });

  it('keeps a measured dark ground when it is genuinely different', () => {
    const out = completeGrounds({
      canvasColor: measured('#ffffff'),
      canvasColorDark: measured('#101820'),
    });

    expect(out.canvasColorDark?.value).toBe('#101820');
    expect(out.canvasColorDark?.confidence).toBe('high');
  });

  it('overrides a measured dark ground that is not actually darker, and says so', () => {
    // A model handed a page with no dark mode will reach for the nearest thing, which is often the
    // light ground again. Accepting it reproduces the exact bug this module exists for.
    const out = completeGrounds({
      canvasColor: measured(DEEP_PURPLE),
      canvasColorDark: measured('#6a1c9b'),
    });

    expect(out.canvasColorDark?.value).not.toBe('#6a1c9b');
    expect(out.canvasColorDark?.source).toContain('too close');
  });

  /**
   * For an already-dark brand the derived ground CANNOT clear `MIN_GROUND_SEPARATION` — the only
   * value that would is a lighter one, which is the opposite of a dark mode. So the field is still
   * proposed (dropping it hands the question back to `resolveTheme`, which carries a dark canvas
   * across unchanged, and two identical panels is the bug this was built to fix) and the copy is
   * what changes: it must not claim a difference the admin cannot see.
   */
  it('does not claim a visible difference it did not achieve on a dark brand', () => {
    const out = completeGrounds({
      canvasColor: { value: '#111827', confidence: 'high', source: 'measured' },
    });

    const dark = out.canvasColorDark;
    expect(dark?.value).toBeDefined();
    expect(dark?.value).not.toBe('#111827');
    expect(groundsAreDistinct('#111827', dark?.value ?? '')).toBe(false);
    expect(dark?.source).toContain('as far as an already-dark brand goes');
    expect(dark?.source).not.toContain('not the same colour');
  });

  it('still says "not the same colour" when the derivation genuinely got there', () => {
    const out = completeGrounds({
      canvasColor: { value: '#ffffff', confidence: 'high', source: 'measured' },
    });

    const dark = out.canvasColorDark;
    expect(groundsAreDistinct('#ffffff', dark?.value ?? '')).toBe(true);
    expect(dark?.source).toContain('not the same colour');
  });

  it('proposes no dark ground at all when there is nothing left to deepen', () => {
    // At NEAR_BLACK the deepening returns the canvas itself. A field whose value repeats the one
    // above it tells the admin nothing, so it is not offered.
    const out = completeGrounds({
      canvasColor: { value: '#0a0a0a', confidence: 'high', source: 'measured' },
    });

    expect(out.canvasColorDark).toBeUndefined();
    // The light pair is still completed — only the redundant field is withheld.
    expect(out.inkColor?.value).toBeDefined();
  });

  it('replaces an ink that cannot be read on the canvas', () => {
    const out = completeGrounds({
      canvasColor: measured('#8a8a8a'),
      inkColor: measured('#9a9a9a'),
    });

    expect(out.inkColor?.value).not.toBe('#9a9a9a');
    expect(out.inkColor?.source).toContain('would not have read');
    expect(out.inkColor?.confidence).toBe('low');
  });

  it('keeps an ink that does read, at the confidence it arrived with', () => {
    const out = completeGrounds({
      canvasColor: measured('#ffffff'),
      inkColor: measured('#111114'),
    });

    expect(out.inkColor).toEqual(measured('#111114'));
  });

  it('does not mutate the bag it was given', () => {
    const fields = { canvasColor: measured(DEEP_PURPLE) };
    const out = completeGrounds(fields);

    expect(fields).not.toHaveProperty('canvasColorDark');
    expect(out).not.toBe(fields);
  });
});
