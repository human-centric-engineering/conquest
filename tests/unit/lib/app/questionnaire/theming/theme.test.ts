import { describe, it, expect } from 'vitest';

import {
  SUNRISE_THEME_DEFAULTS,
  resolveTheme,
  themeToCssVariables,
  type DemoClientTheme,
} from '@/lib/app/questionnaire/theming';

describe('resolveTheme', () => {
  it('fills an all-null theme with the Sunrise defaults (logo stays null)', () => {
    const resolved = resolveTheme({
      ctaColor: null,
      accentColor: null,
      logoUrl: null,
      welcomeCopy: null,
    });
    expect(resolved).toEqual({
      ctaColor: SUNRISE_THEME_DEFAULTS.ctaColor,
      accentColor: SUNRISE_THEME_DEFAULTS.accentColor,
      logoUrl: null,
      welcomeCopy: SUNRISE_THEME_DEFAULTS.welcomeCopy,
      // F7.1+ chrome: no surface, solid CTA, no logo backdrop when nothing is set.
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
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
      welcomeCopy: 'Welcome to the Acme demo.',
    };
    const resolved = resolveTheme(theme);
    expect(resolved.ctaColor).toBe('#ff0000');
    expect(resolved.logoUrl).toBe('https://acme.example/logo.png');
    expect(resolved.welcomeCopy).toBe('Welcome to the Acme demo.');
    // Only the null accent falls back.
    expect(resolved.accentColor).toBe(SUNRISE_THEME_DEFAULTS.accentColor);
  });

  it('preserves a set logo URL', () => {
    expect(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: 'https://acme.example/logo.svg',
        welcomeCopy: null,
      }).logoUrl
    ).toBe('https://acme.example/logo.svg');
  });

  it('passes surfaceColor and ctaColorEnd through when set', () => {
    const resolved = resolveTheme({
      ctaColor: '#280039',
      accentColor: null,
      logoUrl: null,
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
        welcomeCopy: null,
        logoBackgroundEnabled: true,
      });
      expect(resolved.logoBackgroundColor).toBeNull();
    });
  });
});

describe('themeToCssVariables', () => {
  it('emits the colour custom properties', () => {
    const vars = themeToCssVariables(resolveTheme(null));
    expect(vars['--app-cta-color']).toBe(SUNRISE_THEME_DEFAULTS.ctaColor);
    expect(vars['--app-accent-color']).toBe(SUNRISE_THEME_DEFAULTS.accentColor);
  });

  it('omits the logo variable when there is no logo (no url(null))', () => {
    const vars = themeToCssVariables(resolveTheme(null));
    expect(vars).not.toHaveProperty('--app-logo-url');
  });

  it('emits a solid CTA gradient var equal to the CTA colour when no end colour is set', () => {
    const vars = themeToCssVariables(resolveTheme(null));
    expect(vars['--app-cta-gradient']).toBe(SUNRISE_THEME_DEFAULTS.ctaColor);
  });

  it('emits a linear-gradient CTA var when an end colour is set', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: '#280039',
        accentColor: null,
        logoUrl: null,
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
        welcomeCopy: null,
        surfaceColor: '#280039',
        logoBackgroundColor: '#280039',
        logoBackgroundEnabled: true,
      })
    );
    expect(branded['--app-surface-color']).toBe('#280039');
    expect(branded['--app-logo-bg']).toBe('#280039');
  });

  it('wraps a present logo in a quoted url() for the CSS variable', () => {
    const vars = themeToCssVariables(
      resolveTheme({
        ctaColor: null,
        accentColor: null,
        logoUrl: 'https://acme.example/logo.png',
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
      welcomeCopy: 'hi',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
    });
    const v = vars['--app-logo-url'];
    // The injected closing-quote is escaped, so the value stays a single url("…") token.
    expect(v).toBe('url("https://x/a.png\\");background:url(\\"https://evil/x.png")');
    expect(v.startsWith('url("')).toBe(true);
    expect(v.endsWith('")')).toBe(true);
  });
});
