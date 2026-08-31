/**
 * Unit tests: the contrast audit.
 *
 * The audit decides what the admin is shown, so the tests are about coverage and honesty rather
 * than arithmetic (the solver has its own suite):
 *
 *  - **it measures the RESOLVED theme, not the authored one.** An admin who sets an ink and no
 *    canvas gets their ink on our default ground, and auditing only authored pairs would leave the
 *    one combination guaranteed to be unreadable as the one combination nothing checks.
 *  - **it measures the pairs nothing else does.** The form already warns about ink on canvas. The
 *    button label, the band title and the accent are all derived, which reads as "handled" and is
 *    not — and the accent is rendered on BOTH grounds from one column.
 *  - **the thresholds differ by kind.** Text is 4.5:1; the accent is a UI colour at 3:1. Holding
 *    the accent to 4.5 made every brand unfixable, including ConQuest's own.
 *  - **a repair reports the pair it produces**, re-deriving a label that flips.
 *
 * @see lib/app/questionnaire/brand-contrast/audit.ts
 */

import { describe, it, expect } from 'vitest';

import { MIN_UI_CONTRAST_RATIO, auditTheme } from '@/lib/app/questionnaire/brand-contrast/audit';
import { MIN_CONTRAST_RATIO, contrastRatio } from '@/lib/app/questionnaire/theming';
import type { DemoClientTheme } from '@/lib/app/questionnaire/theming';

/** The four columns `DemoClientTheme` declares required-but-nullable, so cases stay short. */
function theme(over: Partial<DemoClientTheme> = {}): DemoClientTheme {
  return { ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: null, ...over };
}

const pairs = (t: DemoClientTheme | null) => auditTheme(t).map((a) => a.finding.pair);

describe('auditTheme — what it looks at', () => {
  it('passes a client with no brand at all', () => {
    // The defaults have to be clean, or every unbranded client opens on a wall of complaints about
    // colours they never chose.
    expect(auditTheme(null)).toEqual([]);
    expect(auditTheme(theme())).toEqual([]);
  });

  it('passes ConQuest’s own palette', () => {
    // A feature that fails our own colours is measuring the wrong thing. This is the check that
    // caught the accent threshold: at 4.5:1 the ConQuest blue failed against the dark ground.
    expect(pairs(theme({ ctaColor: '#0a1a3a', accentColor: '#2f6bff' }))).toEqual([]);
  });

  it('catches an ink set against a canvas that was never set', () => {
    // Straight off a brand guideline — "ink: #FFFFFF" — with no canvas to go with it. The
    // stylesheet pairs it with the DEFAULT white page, and nothing but this notices.
    expect(pairs(theme({ inkColor: '#ffffff' }))).toContain('canvas-light');
  });

  it('catches a button label that cannot read on its own button', () => {
    // The label is derived, which looks like it is handled automatically. It is chosen for
    // contrast, but "the better of white and near-black" is not the same as "readable".
    expect(pairs(theme({ ctaColor: '#7a7a7a' }))).toContain('cta');
  });

  it('checks the far end of a button gradient, where the same label still has to read', () => {
    const found = pairs(theme({ ctaColor: '#0a1a3a', ctaColorEnd: '#8a7f6a' }));
    expect(found).toContain('cta-end');
  });

  it('does not invent a gradient end when there is none', () => {
    expect(pairs(theme({ ctaColor: '#7a7a7a' }))).not.toContain('cta-end');
  });

  it('checks the header band title, and only when there is a band', () => {
    expect(pairs(theme({ surfaceColor: '#767676' }))).toContain('surface');
    expect(pairs(theme({ ctaColor: '#7a7a7a' }))).not.toContain('surface');
  });

  it('checks the accent on BOTH grounds, because one column paints both', () => {
    // `--app-accent-color` is emitted once and rendered in light and dark alike, so an accent
    // chosen against a cream page is also the link colour on the dark one.
    const found = pairs(theme({ accentColor: '#0a1a3a' }));
    expect(found).toContain('accent-dark');
  });

  it('never proposes anything for the logo backdrop', () => {
    // What sits on it is an image, and no ratio says whether a lockup reads on a backdrop.
    const audited = auditTheme(
      theme({
        logoBackgroundEnabled: true,
        logoBackgroundColor: '#767676',
        surfaceColor: '#767676',
      })
    );
    for (const { repairs } of audited) {
      expect(repairs.map((r) => r.field)).not.toContain('logoBackgroundColor');
    }
  });
});

describe('auditTheme — thresholds', () => {
  it('holds text to 4.5:1', () => {
    const [found] = auditTheme(theme({ canvasColor: '#fffcf5', inkColor: '#9a9a8f' }));
    expect(found.finding.target).toBe(MIN_CONTRAST_RATIO);
  });

  it('holds the accent to the 3:1 UI threshold, not the text one', () => {
    // WCAG 1.4.11. The accent drives focus rings, borders and button grounds — not running copy —
    // and at 4.5 essentially no saturated colour clears both grounds, so every brand got an
    // unfixable it could do nothing about.
    const [found] = auditTheme(theme({ accentColor: '#0a1a3a' }));
    expect(found.finding.target).toBe(MIN_UI_CONTRAST_RATIO);
    expect(MIN_UI_CONTRAST_RATIO).toBeLessThan(MIN_CONTRAST_RATIO);
  });
});

describe('auditTheme — the repairs it offers', () => {
  const lowContrastGround = theme({ canvasColor: '#fffcf5', inkColor: '#9a9a8f' });

  it('offers both sides of a ground/ink failure, nearest change first', () => {
    const [{ repairs }] = auditTheme(lowContrastGround);
    expect(repairs.map((r) => r.field)).toEqual(['inkColor', 'canvasColor']);
    expect(Math.abs(repairs[0].amount)).toBeLessThanOrEqual(Math.abs(repairs[1].amount));
  });

  it('offers only the button colour for a button, because its label is chosen for it', () => {
    const [{ repairs }] = auditTheme(theme({ ctaColor: '#7a7a7a' }));
    expect(repairs.map((r) => r.field)).toEqual(['ctaColor']);
  });

  it('every repair actually reaches the target it claims', () => {
    for (const { finding, repairs } of auditTheme(lowContrastGround)) {
      for (const repair of repairs) {
        expect(repair.ratio).toBeGreaterThanOrEqual(finding.target);
        expect(contrastRatio(repair.resultingGround, repair.resultingInk)).toBeCloseTo(
          repair.ratio,
          5
        );
      }
    }
  });

  it('reports the pair each repair produces, so the two sides are distinguishable', () => {
    // White ink on the default white page: ground and ink are the SAME colour, so working out
    // "which half moved" by comparing hexes is impossible. Both repairs land on one value and only
    // the resulting pair tells them apart.
    const [{ repairs }] = auditTheme(theme({ inkColor: '#ffffff' }));
    const ink = repairs.find((r) => r.field === 'inkColor');
    const canvas = repairs.find((r) => r.field === 'canvasColor');
    expect(ink?.resultingGround).toBe('#ffffff');
    expect(canvas?.resultingInk).toBe('#ffffff');
    expect(ink?.resultingInk).toBe(ink?.to);
    expect(canvas?.resultingGround).toBe(canvas?.to);
  });

  it('re-derives a button label that would flip when the button moves', () => {
    // `readableTextColor` switches from dark to light around a mid-tone, so a repair that crosses
    // that point changes the label as well as the ground. Reporting the old one would show a
    // preview the surface does not produce.
    const [{ repairs }] = auditTheme(theme({ ctaColor: '#7a7a7a' }));
    for (const repair of repairs) {
      expect(contrastRatio(repair.resultingGround, repair.resultingInk)).toBeGreaterThanOrEqual(
        MIN_CONTRAST_RATIO
      );
    }
  });

  it('says what the field holds now and what actually renders, separately', () => {
    // `from` is null for a field the admin has never filled in, and the dialog says so; `current`
    // is what the swatch has to paint, because a blank "before" asks them to judge against nothing.
    const [{ repairs }] = auditTheme(theme({ inkColor: '#ffffff' }));
    const canvas = repairs.find((r) => r.field === 'canvasColor');
    expect(canvas?.from).toBeNull();
    expect(canvas?.current).toBe('#ffffff');
  });

  it('never offers a repair that changes nothing', () => {
    // `nearestReadableShade` returns the colour untouched when it already satisfies its own
    // constraints — which happens when the OTHER half of the pair is the problem. Offering it
    // would be a fix that does not fix the thing it names.
    for (const { repairs } of auditTheme(lowContrastGround)) {
      for (const repair of repairs) {
        expect(repair.amount).not.toBe(0);
        expect(repair.to).not.toBe(repair.current);
      }
    }
  });

  it('solves the accent against both grounds at once, not just the failing one', () => {
    const audited = auditTheme(theme({ accentColor: '#0a1a3a' }));
    const [{ repairs }] = audited;
    const repaired = repairs[0].to;
    expect(contrastRatio(repaired, '#ffffff')).toBeGreaterThanOrEqual(MIN_UI_CONTRAST_RATIO);
    expect(contrastRatio(repaired, '#0a0a0a')).toBeGreaterThanOrEqual(MIN_UI_CONTRAST_RATIO);
  });

  it('leaves a pair with no working shade repairless rather than proposing a near miss', () => {
    // Reported as unfixable by the caller. A "closest we could get" that still fails would read as
    // a fix and ship an unreadable theme.
    const audited = auditTheme(theme({ canvasColor: '#808080', inkColor: '#7f7f7f' }));
    const impossible = audited.filter((a) => a.repairs.length === 0);
    for (const { finding } of impossible) {
      expect(finding.ratio).toBeLessThan(finding.target);
    }
  });
});
