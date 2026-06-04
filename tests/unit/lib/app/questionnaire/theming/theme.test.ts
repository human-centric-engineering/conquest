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
    });
    const v = vars['--app-logo-url'];
    // The injected closing-quote is escaped, so the value stays a single url("…") token.
    expect(v).toBe('url("https://x/a.png\\");background:url(\\"https://evil/x.png")');
    expect(v.startsWith('url("')).toBe(true);
    expect(v.endsWith('")')).toBe(true);
  });
});
