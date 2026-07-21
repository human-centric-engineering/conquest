import { describe, it, expect } from 'vitest';

import {
  CONQUEST_THEME_DEFAULTS,
  cssUrl,
  readableTextColor,
  resolveTheme,
  themeToCssVariables,
  type DemoClientTheme,
} from '@/lib/app/questionnaire/theming';

describe('resolveTheme', () => {
  it('fills an all-null theme with the ConQuest defaults (logo stays null)', () => {
    const resolved = resolveTheme({
      ctaColor: null,
      accentColor: null,
      logoUrl: null,
      bannerUrl: null,
      welcomeCopy: null,
    });
    expect(resolved).toEqual({
      ctaColor: CONQUEST_THEME_DEFAULTS.ctaColor,
      accentColor: CONQUEST_THEME_DEFAULTS.accentColor,
      logoUrl: null,
      bannerUrl: null,
      welcomeCopy: CONQUEST_THEME_DEFAULTS.welcomeCopy,
      // F7.1+ chrome: no surface, solid CTA, no logo backdrop when nothing is set.
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      // Nothing visual supplied → the renderer falls back to the ConQuest identity.
      hasBrandIdentity: false,
    });
  });

  it('treats a null client (generic demo) the same as an all-null theme', () => {
    expect(resolveTheme(null)).toEqual(
      resolveTheme({ ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: null })
    );
  });

  it('keeps every supplied field and only defaults the missing ones', () => {
    const theme: DemoClientTheme = {
      ctaColor: '#ff0000',
      accentColor: null,
      logoUrl: 'https://acme.example/logo.png',
      bannerUrl: null,
      welcomeCopy: 'Welcome to the Acme demo.',
    };
    const resolved = resolveTheme(theme);
    expect(resolved.ctaColor).toBe('#ff0000');
    expect(resolved.logoUrl).toBe('https://acme.example/logo.png');
    expect(resolved.welcomeCopy).toBe('Welcome to the Acme demo.');
    // Only the null accent falls back.
    expect(resolved.accentColor).toBe(CONQUEST_THEME_DEFAULTS.accentColor);
  });

  it('preserves a set logo URL', () => {
    expect(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: 'https://acme.example/logo.svg',
        bannerUrl: null,
        welcomeCopy: null,
      }).logoUrl
    ).toBe('https://acme.example/logo.svg');
  });

  it('passes surfaceColor and ctaColorEnd through when set', () => {
    const resolved = resolveTheme({
      ctaColor: '#280039',
      accentColor: null,
      logoUrl: null,
      bannerUrl: null,
      welcomeCopy: null,
      surfaceColor: '#280039',
      ctaColorEnd: '#FF03DF',
    });
    expect(resolved.surfaceColor).toBe('#280039');
    expect(resolved.ctaColorEnd).toBe('#FF03DF');
  });

  describe('logo backdrop resolution', () => {
    it('is null when the backdrop is disabled, even if a colour is set', () => {
      const resolved = resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        logoBackgroundColor: '#280039',
        logoBackgroundEnabled: false,
      });
      expect(resolved.logoBackgroundColor).toBeNull();
    });

    it('uses the explicit logo background colour when enabled', () => {
      const resolved = resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        surfaceColor: '#111111',
        logoBackgroundColor: '#280039',
        logoBackgroundEnabled: true,
      });
      expect(resolved.logoBackgroundColor).toBe('#280039');
    });

    it('falls back to the surface colour when enabled with no explicit colour', () => {
      const resolved = resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        surfaceColor: '#280039',
        logoBackgroundColor: null,
        logoBackgroundEnabled: true,
      });
      expect(resolved.logoBackgroundColor).toBe('#280039');
    });

    it('is null when enabled but neither a logo background nor a surface colour is set', () => {
      const resolved = resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        logoBackgroundEnabled: true,
      });
      expect(resolved.logoBackgroundColor).toBeNull();
    });
  });
});

describe('resolveTheme — hasBrandIdentity (the white-label switch)', () => {
  const bare = { ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: null };

  it('is false for a null client and for an all-null theme', () => {
    expect(resolveTheme(null).hasBrandIdentity).toBe(false);
    expect(resolveTheme(bare).hasBrandIdentity).toBe(false);
  });

  // Each visual column alone is enough to claim the surface.
  it.each([
    ['ctaColor', { ...bare, ctaColor: '#280039' }],
    ['accentColor', { ...bare, accentColor: '#280039' }],
    ['logoUrl', { ...bare, logoUrl: 'https://acme.example/logo.png' }],
    ['surfaceColor', { ...bare, surfaceColor: '#280039' }],
    ['ctaColorEnd', { ...bare, ctaColorEnd: '#280039' }],
  ])('is true when only %s is set', (_field, theme) => {
    expect(resolveTheme(theme as DemoClientTheme).hasBrandIdentity).toBe(true);
  });

  it('is true when a logo backdrop resolves, via the surface fallback', () => {
    expect(
      resolveTheme({ ...bare, surfaceColor: '#280039', logoBackgroundEnabled: true })
        .hasBrandIdentity
    ).toBe(true);
  });

  it('ignores welcomeCopy — copy is not visual identity', () => {
    // A client that only rewords its invitation line still gets ConQuest chrome.
    expect(
      resolveTheme({ ...bare, welcomeCopy: 'Welcome to the Acme demo.' }).hasBrandIdentity
    ).toBe(false);
  });

  it('is not fooled by the defaults it applies to itself', () => {
    // resolveTheme fills ctaColor/accentColor from CONQUEST_THEME_DEFAULTS; the flag must
    // read the RAW columns or every client would look branded.
    const resolved = resolveTheme(bare);
    expect(resolved.ctaColor).toBe(CONQUEST_THEME_DEFAULTS.ctaColor);
    expect(resolved.hasBrandIdentity).toBe(false);
  });
});

describe('cssUrl', () => {
  it('wraps a URL in a quoted url()', () => {
    expect(cssUrl('https://acme.example/logo.png')).toBe('url("https://acme.example/logo.png")');
  });

  it('escapes quotes, backslashes and newlines so the value cannot terminate url()', () => {
    expect(cssUrl('a".png')).toBe('url("a\\".png")');
    expect(cssUrl('a\\b.png')).toBe('url("a\\\\b.png")');
    expect(cssUrl('a\nb.png')).toBe('url("a\\\nb.png")');
  });
});

describe('themeToCssVariables', () => {
  it('emits the colour custom properties for a branded client', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: '#280039',
        accentColor: '#FF03DF',
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
      })
    );
    expect(vars['--app-cta-color']).toBe('#280039');
    expect(vars['--app-accent-color']).toBe('#FF03DF');
  });

  it('pairs a readable foreground with the CTA, so a pale brand is not white-on-white', () => {
    // The CTAs paint their background from --app-cta-gradient directly and never consult
    // the platform primary/primary-foreground pair, so the pairing has to travel with the
    // brand or every button hardcodes white and hopes.
    const dark = themeToCssVariables(
      resolveTheme({ ctaColor: '#0a1a3a', accentColor: null, logoUrl: null, welcomeCopy: null })
    );
    const pale = themeToCssVariables(
      resolveTheme({ ctaColor: '#ffe680', accentColor: null, logoUrl: null, welcomeCopy: null })
    );
    expect(dark['--app-on-cta']).toBe('#ffffff');
    expect(pale['--app-on-cta']).toBe('#1a1a1a');
  });

  it('omits --app-on-cta for an unbranded client, leaving the mode-aware CSS to pair it', () => {
    // ConQuest flips navy → gold with the theme; a flat inline value would pin one of them
    // and put white on gold in dark mode (~1.7:1).
    const vars = themeToCssVariables(resolveTheme(null));
    expect(vars['--app-on-cta']).toBeUndefined();
  });

  it('emits NO colour variables for an unbranded client, so the ConQuest CSS defaults win', () => {
    // Inline styles beat the stylesheet, so emitting the flat ConQuest hexes here would
    // pin light mode and break the dark-mode flip that [data-brand='conquest'] provides.
    const vars = themeToCssVariables(resolveTheme(null));
    expect(vars).not.toHaveProperty('--app-cta-color');
    expect(vars).not.toHaveProperty('--app-accent-color');
    expect(vars).not.toHaveProperty('--app-cta-gradient');
  });

  it('omits the logo variable when there is no logo (no url(null))', () => {
    const vars = themeToCssVariables(resolveTheme(null));
    expect(vars).not.toHaveProperty('--app-logo-url');
  });

  it('emits a solid CTA gradient var equal to the CTA colour when no end colour is set', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: '#280039',
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
      })
    );
    expect(vars['--app-cta-gradient']).toBe('#280039');
  });

  it('emits a linear-gradient CTA var when an end colour is set', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: '#280039',
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        ctaColorEnd: '#FF03DF',
      })
    );
    expect(vars['--app-cta-gradient']).toBe('linear-gradient(135deg, #280039, #FF03DF)');
  });

  it('emits the surface and logo-background vars only when those resolve to a colour', () => {
    const bare = themeToCssVariables(resolveTheme(null));
    expect(bare).not.toHaveProperty('--app-surface-color');
    expect(bare).not.toHaveProperty('--app-logo-bg');

    const branded = themeToCssVariables(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        surfaceColor: '#280039',
        logoBackgroundColor: '#280039',
        logoBackgroundEnabled: true,
      })
    );
    expect(branded['--app-surface-color']).toBe('#280039');
    expect(branded['--app-logo-bg']).toBe('#280039');
  });

  it('emits --app-on-surface (white on a dark surface) alongside --app-surface-color', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        surfaceColor: '#16243f', // deep navy
      })
    );
    expect(vars['--app-on-surface']).toBe('#ffffff');
  });

  it('picks dark on-surface text for a light surface, and omits the var with no surface', () => {
    const light = themeToCssVariables(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: null,
        bannerUrl: null,
        welcomeCopy: null,
        surfaceColor: '#f4f1ea', // pale cream
      })
    );
    expect(light['--app-on-surface']).toBe('#1a1a1a');
    expect(themeToCssVariables(resolveTheme(null))).not.toHaveProperty('--app-on-surface');
  });
});

describe('readableTextColor', () => {
  it('returns white for dark backgrounds and near-black for light ones', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#16243f')).toBe('#ffffff');
    expect(readableTextColor('#ffffff')).toBe('#1a1a1a');
    expect(readableTextColor('#f4f1ea')).toBe('#1a1a1a');
  });

  it('accepts shorthand hex and a missing leading hash', () => {
    expect(readableTextColor('#000')).toBe('#ffffff');
    expect(readableTextColor('fff')).toBe('#1a1a1a');
  });

  it('returns null for an unparseable colour (caller omits the variable)', () => {
    expect(readableTextColor('rebeccapurple')).toBeNull();
    expect(readableTextColor('#12')).toBeNull();
  });

  it('wraps a present logo in a quoted url() for the CSS variable', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: 'https://acme.example/logo.png',
        bannerUrl: null,
        welcomeCopy: null,
      })
    );
    expect(vars['--app-logo-url']).toBe('url("https://acme.example/logo.png")');
  });

  it('CSS-escapes a logo URL so it cannot break out of url() (defence in depth)', () => {
    // A stored value that slipped past the https validator (seed / direct DB write)
    // must not inject an extra declaration when the F7.1 UI applies the variable.
    const vars = themeToCssVariables({
      ctaColor: '#000',
      accentColor: '#000',
      logoUrl: 'https://x/a.png");background:url("https://evil/x.png',
      bannerUrl: null,
      welcomeCopy: 'hi',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      hasBrandIdentity: true,
    });
    const v = vars['--app-logo-url'];
    // The injected closing-quote is escaped, so the value stays a single url("…") token.
    expect(v).toBe('url("https://x/a.png\\");background:url(\\"https://evil/x.png")');
    expect(v.startsWith('url("')).toBe(true);
    expect(v.endsWith('")')).toBe(true);
  });
});
