/**
 * The brand kit: the ground a questionnaire is drawn on, the type it is set in, and which
 * lockup ends up in the band.
 *
 * Kept apart from `theme.test.ts` (which covers the original palette and the CSS sink)
 * because these behaviours are derivations rather than pass-throughs — the ink, the
 * dark/light judgement and the lockup choice are all computed, and each has a wrong answer
 * that renders as "nothing visibly broken" rather than as a failure:
 *
 *  - ink derived against the wrong ground → light text on a light canvas,
 *  - `bandLogoUrl` picking the ink lockup on a dark band → an invisible logo,
 *  - `fontPairing` widening the white-label switch → ConQuest chrome silently dropped from a
 *    client who only picked a typeface.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_FONT_PAIRING,
  FONT_PAIRINGS,
  FONT_PAIRING_STACKS,
  MIN_CONTRAST_RATIO,
  contrastRatio,
  readableTextColor,
  resolveFontPairing,
  resolveTheme,
  themeToCssVariables,
  type DemoClientTheme,
} from '@/lib/app/questionnaire/theming';

/** The four required fields of the raw contract, so each test states only what it exercises. */
const base = (over: Partial<DemoClientTheme> = {}): DemoClientTheme => ({
  ctaColor: null,
  accentColor: null,
  logoUrl: null,
  welcomeCopy: null,
  ...over,
});

/** Does this colour want light text on it? The same question `resolveTheme` asks internally. */
const isDark = (hex: string) => readableTextColor(hex) === '#ffffff';

const LIGHT_CANVAS = '#fffcf5'; // paper
const DARK_CANVAS = '#0b1f3a'; // deep navy

describe('resolveTheme — the ground', () => {
  it('derives ink for contrast when the admin sets a canvas but no ink', () => {
    // The whole reason ink is optional: an admin who picks a midnight canvas should not
    // also have to work out that they now need light text.
    expect(resolveTheme(base({ canvasColor: DARK_CANVAS })).onCanvas).toBe('#ffffff');
    expect(resolveTheme(base({ canvasColor: LIGHT_CANVAS })).onCanvas).toBe('#1a1a1a');
  });

  it('prefers an explicit ink over the derived one', () => {
    const resolved = resolveTheme(base({ canvasColor: DARK_CANVAS, inkColor: '#c9d7ff' }));
    expect(resolved.onCanvas).toBe('#c9d7ff');
  });

  it('applies an ink set WITHOUT a canvas — it lands on the neutral ground', () => {
    // Not a no-op: the two halves are independent settings, and a brand may want its own
    // ink on the default white.
    const resolved = resolveTheme(base({ inkColor: '#333333' }));
    expect(resolved.onCanvas).toBe('#333333');
    expect(resolved.canvasColor).toBeNull();
  });

  it('leaves onCanvas null when neither half is set, so the surface keeps its own token', () => {
    expect(resolveTheme(base()).onCanvas).toBeNull();
  });

  it('reports canvasIsDark from the same judgement that derives the ink', () => {
    // Two readings of one number, never two thresholds: a mid-tone that gets light ink must
    // also report as dark, or the lockup choice and the text colour disagree on the same wall.
    for (const hex of ['#000000', DARK_CANVAS, '#556677']) {
      const resolved = resolveTheme(base({ canvasColor: hex }));
      expect(resolved.canvasIsDark).toBe(resolved.onCanvas === '#ffffff');
    }
    expect(resolveTheme(base({ canvasColor: LIGHT_CANVAS })).canvasIsDark).toBe(false);
  });

  it('does not let an explicit LIGHT ink make a light canvas report as dark', () => {
    // canvasIsDark is about the ground, not about the text someone chose to put on it.
    const resolved = resolveTheme(base({ canvasColor: LIGHT_CANVAS, inkColor: '#ffffff' }));
    expect(resolved.canvasIsDark).toBe(false);
  });
});

describe('resolveTheme — which lockup the band draws', () => {
  const LIGHT_LOCKUP = 'https://acme.example/logo.png';
  const DARK_LOCKUP = 'https://acme.example/logo-dark.png';

  it('uses the standard lockup when there is no ground at all', () => {
    const resolved = resolveTheme(base({ logoUrl: LIGHT_LOCKUP, logoDarkUrl: DARK_LOCKUP }));
    expect(resolved.bandLogoUrl).toBe(LIGHT_LOCKUP);
  });

  it('switches to the dark lockup on a dark surface band', () => {
    const resolved = resolveTheme(
      base({ logoUrl: LIGHT_LOCKUP, logoDarkUrl: DARK_LOCKUP, surfaceColor: DARK_CANVAS })
    );
    expect(resolved.bandLogoUrl).toBe(DARK_LOCKUP);
  });

  it('follows the logo BACKDROP ahead of the surface — it is the nearer ground', () => {
    // The backdrop chip is what the logo actually sits on. A dark band with a white chip
    // behind the logo must take the ink lockup, not the light-on-dark one.
    const resolved = resolveTheme(
      base({
        logoUrl: LIGHT_LOCKUP,
        logoDarkUrl: DARK_LOCKUP,
        surfaceColor: DARK_CANVAS,
        logoBackgroundColor: '#ffffff',
        logoBackgroundEnabled: true,
      })
    );
    expect(resolved.bandLogoUrl).toBe(LIGHT_LOCKUP);
  });

  it('falls back to the canvas when there is no band colour and no backdrop', () => {
    const resolved = resolveTheme(
      base({ logoUrl: LIGHT_LOCKUP, logoDarkUrl: DARK_LOCKUP, canvasColor: DARK_CANVAS })
    );
    expect(resolved.bandLogoUrl).toBe(DARK_LOCKUP);
  });

  it('keeps the standard lockup on a dark ground when no dark artwork was supplied', () => {
    // Degraded, but the alternative is a band with no mark in it at all.
    const resolved = resolveTheme(base({ logoUrl: LIGHT_LOCKUP, surfaceColor: DARK_CANVAS }));
    expect(resolved.bandLogoUrl).toBe(LIGHT_LOCKUP);
  });

  it('leaves logoUrl itself untouched, because the email and the PDFs render onto white', () => {
    const resolved = resolveTheme(
      base({ logoUrl: LIGHT_LOCKUP, logoDarkUrl: DARK_LOCKUP, surfaceColor: DARK_CANVAS })
    );
    expect(resolved.logoUrl).toBe(LIGHT_LOCKUP);
  });

  it('uses the dark lockup alone when it is the only artwork on a dark ground', () => {
    const resolved = resolveTheme(base({ logoDarkUrl: DARK_LOCKUP, surfaceColor: DARK_CANVAS }));
    expect(resolved.bandLogoUrl).toBe(DARK_LOCKUP);
  });
});

describe('resolveTheme — what counts as a brand identity', () => {
  // Each of these claims the surface on its own: the client has shown us something visual
  // to protect, so ConQuest chrome steps back.
  const CLAIMS_THE_SURFACE: Array<[string, Partial<DemoClientTheme>]> = [
    ['a canvas', { canvasColor: LIGHT_CANVAS }],
    ['an ink colour', { inkColor: '#333333' }],
    ['a second accent', { accentColorEnd: '#7b5cff' }],
    ['a square mark', { logoMarkUrl: 'https://acme.example/mark.png' }],
    ['a dark lockup', { logoDarkUrl: 'https://acme.example/logo-dark.png' }],
  ];

  it.each(CLAIMS_THE_SURFACE)('%s is enough on its own', (_label, fields) => {
    expect(resolveTheme(base(fields)).hasBrandIdentity).toBe(true);
  });

  it('a typeface alone is NOT — it is a design choice, not an identity', () => {
    // Same reasoning as welcomeCopy: a client who picked the editorial serif and nothing
    // else has handed us no brand to protect, so the questionnaire keeps ConQuest colours
    // and the wordmark — set in that serif.
    const resolved = resolveTheme(base({ fontPairing: 'editorial' }));
    expect(resolved.hasBrandIdentity).toBe(false);
    expect(resolved.fontPairing).toBe('editorial');
  });
});

describe('themeToCssVariables — the brand-kit variables', () => {
  it('emits the ground per MODE, never as one value', () => {
    // `--app-canvas-color` is published by the stylesheet, not by the resolver: the respondent
    // switches modes client-side, long after this ran, and a single value could not follow them.
    const canvasOnly = themeToCssVariables(resolveTheme(base({ canvasColor: LIGHT_CANVAS })));
    expect(canvasOnly['--app-canvas-color']).toBeUndefined();
    expect(canvasOnly['--app-canvas-light']).toBe(LIGHT_CANVAS);
    expect(canvasOnly['--app-ink-light']).toBe('#1a1a1a');
    // Derived, so both dark halves are emitted too — a client who set only a light canvas still
    // gets a branded dark mode rather than dropping to the neutral near-black.
    expect(canvasOnly['--app-canvas-dark']).toBeDefined();
    expect(canvasOnly['--app-ink-dark']).toBe('#ffffff');

    const neither = themeToCssVariables(resolveTheme(base()));
    for (const v of [
      '--app-canvas-light',
      '--app-ink-light',
      '--app-canvas-dark',
      '--app-ink-dark',
    ]) {
      expect(neither[v]).toBeUndefined();
    }
  });

  it('emits the second accent and its aura together, or neither', () => {
    const withEnd = themeToCssVariables(
      resolveTheme(base({ accentColor: '#38bdf8', accentColorEnd: '#0ea5e9' }))
    );
    expect(withEnd['--app-accent-end']).toBe('#0ea5e9');
    // A gradient of two translucent stops rather than a flat hex: the aura is laid OVER
    // whatever ground the layout puts it on, so flattening it would bake in a background.
    expect(withEnd['--app-accent-aura']).toContain('color-mix');
    expect(withEnd['--app-accent-aura']).toContain('#0ea5e9');

    const withoutEnd = themeToCssVariables(resolveTheme(base({ accentColor: '#38bdf8' })));
    expect(withoutEnd['--app-accent-end']).toBeUndefined();
    expect(withoutEnd['--app-accent-aura']).toBeUndefined();
  });

  it('escapes the mark URL through the same url() sink as the logo', () => {
    const hostile = 'https://acme.example/mark.png");background:red;--x:url("';
    const vars = themeToCssVariables(resolveTheme(base({ logoMarkUrl: hostile })));
    // The quote is escaped, so the value cannot terminate url() and inject a declaration.
    expect(vars['--app-logo-mark-url']).toContain('\\"');
    expect(vars['--app-logo-mark-url']?.startsWith('url("')).toBe(true);
  });

  it('emits the band lockup per mode, not the raw logo', () => {
    const vars = themeToCssVariables(
      resolveTheme(
        base({
          logoUrl: 'https://acme.example/logo.png',
          logoDarkUrl: 'https://acme.example/logo-dark.png',
          surfaceColor: DARK_CANVAS,
        })
      )
    );
    // The band paints a dark surface in BOTH modes here, so both sources are the dark artwork.
    expect(vars['--app-logo-src']).toContain('logo-dark.png');
    expect(vars['--app-logo-src-dark']).toContain('logo-dark.png');
    // The published variable is the stylesheet's job — see app/brand-theme.css.
    expect(vars['--app-logo-url']).toBeUndefined();
  });

  it('emits DIFFERENT lockups per mode when the ground itself changes with the mode', () => {
    // The case the split exists for: a pale paper stock in light mode, its derived dark
    // counterpart at night. One variable could only have served one of them.
    const vars = themeToCssVariables(
      resolveTheme(
        base({
          logoUrl: 'https://acme.example/logo.png',
          logoDarkUrl: 'https://acme.example/logo-dark.png',
          canvasColor: LIGHT_CANVAS,
        })
      )
    );
    expect(vars['--app-logo-src']).toContain('logo.png');
    expect(vars['--app-logo-src']).not.toContain('logo-dark.png');
    expect(vars['--app-logo-src-dark']).toContain('logo-dark.png');
  });

  it('emits no font variables for the neutral pairing', () => {
    // The stylesheet already declares the neutral stack, and an inline style beats it — so
    // writing it here would pin the system stack onto portalled roots.
    const vars = themeToCssVariables(resolveTheme(base()));
    expect(vars['--app-font-display']).toBeUndefined();
    expect(vars['--app-font-body']).toBeUndefined();
  });

  it.each(['editorial', 'contemporary'] as const)('emits both faces for %s', (pairing) => {
    const vars = themeToCssVariables(resolveTheme(base({ fontPairing: pairing })));
    expect(vars['--app-font-display']).toBe(FONT_PAIRING_STACKS[pairing].display);
    expect(vars['--app-font-body']).toBe(FONT_PAIRING_STACKS[pairing].body);
  });
});

describe('resolveFontPairing', () => {
  it.each(FONT_PAIRINGS)('passes %s through', (pairing) => {
    expect(resolveFontPairing(pairing)).toBe(pairing);
  });

  it.each([null, undefined, '', 'gothic', 'EDITORIAL'])(
    'resolves %s to the default rather than failing',
    (value) => {
      // Forgiving on READ by design: the column is plain TEXT, so a rollback, a seed or a
      // newer deploy can all put an unknown value there, and a questionnaire set in an
      // unrecognised typeface must render in the system stack rather than not render.
      expect(resolveFontPairing(value)).toBe(DEFAULT_FONT_PAIRING);
    }
  );

  it('does not inherit a pairing from Object.prototype', () => {
    // The same trap `resolveLayout` fell into: an `includes` check is safe here, but a
    // future lookup-table rewrite would not be, and this fixes the expectation now.
    expect(resolveFontPairing('constructor')).toBe(DEFAULT_FONT_PAIRING);
    expect(resolveFontPairing('toString')).toBe(DEFAULT_FONT_PAIRING);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white, and symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('is 1:1 for a colour against itself — the case the form warns about', () => {
    expect(contrastRatio('#556677', '#556677')).toBeCloseTo(1, 5);
  });

  it('accepts the short hex form, since the column does', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 1);
  });

  it('returns null for anything unparseable, so the caller omits the warning', () => {
    expect(contrastRatio('nonsense', '#ffffff')).toBeNull();
    expect(contrastRatio('#ffffff', '')).toBeNull();
  });

  it('never scores the derived ink below the alternative — it is always the better of the two', () => {
    // The invariant that actually holds. `readableTextColor` picks whichever of white and
    // near-black contrasts better, so measuring the RESOLVED pair can never be beaten by the
    // colour it rejected. This is what makes the form's warning trustworthy: when it fires on
    // a derived ink, no other ink we would have chosen would have done better.
    for (const canvas of [DARK_CANVAS, LIGHT_CANVAS, '#556677', '#808080']) {
      const resolved = resolveTheme(base({ canvasColor: canvas }));
      const chosen = contrastRatio(canvas, resolved.onCanvas as string) as number;
      const rejected = contrastRatio(
        canvas,
        resolved.onCanvas === '#ffffff' ? '#1a1a1a' : '#ffffff'
      ) as number;
      expect(chosen).toBeGreaterThanOrEqual(rejected);
    }
  });

  it('still falls below AA on a mid-grey canvas — which is the point of warning at all', () => {
    // A mid-tone ground cannot reach 4.5:1 against EITHER white or near-black, so there is no
    // ink we could have derived that would clear the bar. The right response is to say so and
    // let the admin decide, not to pretend the derivation solved it — the warning fires here.
    const resolved = resolveTheme(base({ canvasColor: '#808080' }));
    const ratio = contrastRatio('#808080', resolved.onCanvas as string) as number;
    expect(ratio).toBeLessThan(MIN_CONTRAST_RATIO);
  });

  it('clears AA on the grounds a brand actually picks', () => {
    for (const canvas of [DARK_CANVAS, LIGHT_CANVAS, '#000000', '#ffffff']) {
      const resolved = resolveTheme(base({ canvasColor: canvas }));
      const ratio = contrastRatio(canvas, resolved.onCanvas as string) as number;
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
    }
  });
});

describe('resolveTheme — the ground in dark mode', () => {
  it('derives a dark counterpart from a light canvas, keeping the brand hue', () => {
    // Not the neutral near-black: the point is that a dark-mode Broadsheet still looks like this
    // client's. The derived ground is the brand colour as a tint over near-black, so it is dark
    // enough to be a dark mode and not so dark that the hue is gone.
    const resolved = resolveTheme(base({ canvasColor: '#f5f9ff' }));
    expect(resolved.canvasColorDark).not.toBeNull();
    expect(resolved.canvasColorDark).not.toBe('#f5f9ff');
    expect(resolved.canvasColorDark).not.toBe('#0a0a0a');
    expect(isDark(resolved.canvasColorDark as string)).toBe(true);
  });

  it('derives ink for the derived ground, so a client need supply neither', () => {
    const resolved = resolveTheme(base({ canvasColor: '#f5f9ff' }));
    expect(resolved.onCanvasDark).toBe('#ffffff');
  });

  it('carries an ALREADY-dark canvas across unchanged rather than darkening it twice', () => {
    // Darkening a navy again gives a black rectangle and loses the brand entirely, which is the
    // opposite of what the derivation is for.
    const resolved = resolveTheme(base({ canvasColor: DARK_CANVAS }));
    expect(resolved.canvasColorDark).toBe(DARK_CANVAS);
  });

  it('prefers an explicit dark pair from the client over anything derived', () => {
    const resolved = resolveTheme(
      base({ canvasColor: LIGHT_CANVAS, canvasColorDark: '#101820', inkColorDark: '#d7e3ff' })
    );
    expect(resolved.canvasColorDark).toBe('#101820');
    expect(resolved.onCanvasDark).toBe('#d7e3ff');
  });

  it('leaves both dark fields null when there is no canvas at all', () => {
    // No ground means the surface keeps its own neutral tokens — in both modes.
    const resolved = resolveTheme(base());
    expect(resolved.canvasColorDark).toBeNull();
    expect(resolved.onCanvasDark).toBeNull();
  });

  it('accepts a dark ground on its own, with no light canvas', () => {
    const resolved = resolveTheme(base({ canvasColorDark: '#101820' }));
    expect(resolved.canvasColor).toBeNull();
    expect(resolved.canvasColorDark).toBe('#101820');
    expect(resolved.onCanvasDark).toBe('#ffffff');
    expect(resolved.hasBrandIdentity).toBe(true);
  });

  it('keeps the derived dark ground readable — the whole reason we derive rather than invert', () => {
    for (const canvas of [LIGHT_CANVAS, '#ffffff', '#f5f9ff', '#ffe4e6', '#e0f2fe']) {
      const resolved = resolveTheme(base({ canvasColor: canvas }));
      const ratio = contrastRatio(
        resolved.canvasColorDark as string,
        resolved.onCanvasDark as string
      ) as number;
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
    }
  });
});

describe('resolveTheme — the band lockup follows the mode', () => {
  const LIGHT_LOCKUP = 'https://acme.example/logo.png';
  const DARK_LOCKUP = 'https://acme.example/logo-dark.png';

  it('takes the dark artwork in dark mode even with no band colour set', () => {
    // With no surface and no canvas, the dark-mode ground is the neutral near-black — so the
    // dark lockup is the right one there while the light one is right in light mode.
    const resolved = resolveTheme(base({ logoUrl: LIGHT_LOCKUP, logoDarkUrl: DARK_LOCKUP }));
    expect(resolved.bandLogoUrl).toBe(LIGHT_LOCKUP);
    expect(resolved.bandLogoDarkUrl).toBe(DARK_LOCKUP);
  });

  it('keeps a PALE band colour light in both modes — a surface does not follow the mode', () => {
    // surfaceColor is a single flat colour, so a band painted pale stays pale at night and the
    // ink lockup remains the readable one.
    const resolved = resolveTheme(
      base({ logoUrl: LIGHT_LOCKUP, logoDarkUrl: DARK_LOCKUP, surfaceColor: '#ffffff' })
    );
    expect(resolved.bandLogoUrl).toBe(LIGHT_LOCKUP);
    expect(resolved.bandLogoDarkUrl).toBe(LIGHT_LOCKUP);
  });

  it('falls back to the only artwork there is, in both modes', () => {
    const resolved = resolveTheme(base({ logoUrl: LIGHT_LOCKUP }));
    expect(resolved.bandLogoUrl).toBe(LIGHT_LOCKUP);
    expect(resolved.bandLogoDarkUrl).toBe(LIGHT_LOCKUP);
  });
});

describe('every emitted variable has a stylesheet default', () => {
  const BRAND_THEME_CSS = readFileSync(join(process.cwd(), 'app/brand-theme.css'), 'utf8');

  /**
   * The failure this guards against has no symptom at the point of the mistake: a variable
   * emitted for SOME clients and consumed by a layout paints nothing for every client who
   * did not set it, and `var(--x)` with no value simply drops the declaration. So the test
   * asks the projector itself what it can emit — a fully-branded theme — and checks the
   * stylesheet declares each one.
   *
   * A variable is EXEMPT only when every consumer checks the resolved field before painting
   * with it — the band renders a surface colour only `if (hasSurface)`, the logo chip only
   * `if (hasBackdrop)`, and the image URLs likewise. Those must NOT have defaults: a default
   * surface colour would paint a brand band onto every unbranded questionnaire, and a default
   * `url()` is a broken image rather than a fallback.
   *
   * Everything else is painted unconditionally by something, and therefore needs a value for
   * the clients who set nothing. Moving a variable into this list is a claim about its
   * consumers, so it belongs in a diff someone reads — which is the point of listing them.
   */
  const EVERY_FIELD_SET = resolveTheme(
    base({
      ctaColor: '#0a1a3a',
      accentColor: '#2f6bff',
      canvasColor: DARK_CANVAS,
      inkColor: '#ffffff',
      accentColorEnd: '#7b5cff',
      surfaceColor: '#101010',
      ctaColorEnd: '#22d3ee',
      logoBackgroundColor: '#101010',
      logoBackgroundEnabled: true,
      fontPairing: 'editorial',
    })
  );

  const GUARDED_AT_THE_POINT_OF_USE = [
    // Images: absent for most clients; every consumer branches on the resolved field.
    '--app-logo-url',
    '--app-banner-url',
    '--app-logo-mark-url',
    // The header band's own colours, painted only when the client set a surface.
    '--app-surface-color',
    '--app-on-surface',
    // The logo backdrop chip, drawn only when the backdrop toggle resolved to a colour.
    '--app-logo-bg',
  ];

  it.each(
    Object.keys(themeToCssVariables(EVERY_FIELD_SET)).filter(
      (v) => !GUARDED_AT_THE_POINT_OF_USE.includes(v)
    )
  )('%s has a stylesheet default in app/brand-theme.css', (variable) => {
    // Two shapes count, and both are genuinely a default: the variable is DECLARED with a
    // neutral value (`--app-accent-end: …`), or it is CONSUMED with a fallback
    // (`var(--app-canvas-light, var(--cq-respondent-canvas))`). The per-mode ground and lockup
    // variables take the second shape because the stylesheet, not the resolver, is what knows
    // which mode is in force.
    const declared = BRAND_THEME_CSS.includes(`${variable}:`);
    const consumedWithFallback = BRAND_THEME_CSS.includes(`var(${variable},`);
    expect(declared || consumedWithFallback).toBe(true);
  });
});
