/**
 * Unit tests: the custom type pairing, from stored row to rendered CSS.
 *
 * Three invariants, each of which fails silently if it breaks:
 *
 *  - `fontFaceCss` is emitted ONLY when the pairing is `custom` AND there is an id AND files were
 *    stored. Emitting it otherwise would put `@font-face` rules for faces that do not exist on
 *    every unbranded questionnaire.
 *  - Every `src` points at OUR origin. `font-src` is `'self' data:`, so a rule pointing at
 *    fonts.gstatic.com would be blocked by the CSP and the page would render in the fallback —
 *    looking like a slow font rather than a broken one.
 *  - The stored Json is narrowed defensively. It is a Json column: a seed, a rollback or a restored
 *    backup can put anything in it, and a half-wrong map must degrade to the weights that are valid
 *    rather than throw inside a render.
 */

import { describe, it, expect } from 'vitest';

import {
  NEUTRAL_FONT_STACK,
  resolveTheme,
  themeToCssVariables,
} from '@/lib/app/questionnaire/theming';
import { narrowCustomFontFiles } from '@/lib/app/questionnaire/theming/theme';

const FILES = {
  display: { '400': 'https://blob.example/d400.woff2', '700': 'https://blob.example/d700.woff2' },
  body: { '400': 'https://blob.example/b400.woff2' },
};

/** The four fields `DemoClientTheme` requires, so each test only states what it is about. */
const CUSTOM = {
  ctaColor: null,
  accentColor: null,
  logoUrl: null,
  welcomeCopy: null,
  id: 'dc-1',
  fontPairing: 'custom',
  customFontDisplay: 'Poppins',
  customFontBody: 'Karla',
  customFontFiles: FILES,
};

describe('resolveTheme — custom type', () => {
  it('emits a face per stored weight, pointing at our own origin', () => {
    const css = resolveTheme(CUSTOM).fontFaceCss ?? '';

    expect(css).toContain("font-family:'Poppins'");
    expect(css).toContain('font-weight:400');
    expect(css).toContain('font-weight:700');
    // Same-origin is the whole design: font-src is `'self' data:` and there is no app seam to
    // widen it, so a gstatic URL here would be blocked outright.
    expect(css).toContain('/api/v1/app/demo-clients/dc-1/font/display-400');
    expect(css).toContain('/api/v1/app/demo-clients/dc-1/font/body-400');
    expect(css).not.toContain('gstatic');
  });

  it('declares only the weights that were actually stored', () => {
    const css = resolveTheme(CUSTOM).fontFaceCss ?? '';

    // The body family published no 700; the browser synthesises one, which is far better than
    // declaring a face that 404s.
    expect(css).not.toContain('body-700');
  });

  it('swaps rather than blocking, so the questionnaire renders immediately', () => {
    expect(resolveTheme(CUSTOM).fontFaceCss).toContain('font-display:swap');
  });

  it('emits nothing for any pairing but custom', () => {
    expect(resolveTheme({ ...CUSTOM, fontPairing: 'editorial' }).fontFaceCss).toBeNull();
    expect(resolveTheme({ ...CUSTOM, fontPairing: null }).fontFaceCss).toBeNull();
  });

  it('emits nothing when nothing was stored, so the option is inert until fonts are loaded', () => {
    expect(resolveTheme({ ...CUSTOM, customFontFiles: null }).fontFaceCss).toBeNull();
  });

  it('emits nothing without a client id, since the files could not be addressed', () => {
    expect(resolveTheme({ ...CUSTOM, id: null }).fontFaceCss).toBeNull();
  });

  it('narrows an unrenderable family on read rather than emitting broken CSS', () => {
    // The column is plain text — a seed or a direct write can put anything there.
    const resolved = resolveTheme({ ...CUSTOM, customFontDisplay: 'Poppins&text=x' });

    expect(resolved.customFontDisplay).toBeNull();
    expect(resolved.fontFaceCss).not.toContain('Poppins&text=x');
  });
});

describe('themeToCssVariables — custom type', () => {
  it('sets the stacks from the client’s own families', () => {
    const vars = themeToCssVariables(resolveTheme(CUSTOM));

    expect(vars['--app-font-display']).toContain("'Poppins'");
    expect(vars['--app-font-body']).toContain("'Karla'");
  });

  it('falls back to the system stack for a slot with no family', () => {
    const vars = themeToCssVariables(resolveTheme({ ...CUSTOM, customFontBody: null }));

    expect(vars['--app-font-display']).toContain("'Poppins'");
    expect(vars['--app-font-body']).toBe(NEUTRAL_FONT_STACK);
  });

  it('is the system stack when custom is chosen but nothing is named yet', () => {
    // Not an error state: it is what the row looks like between choosing the option and loading
    // the faces.
    const vars = themeToCssVariables(
      resolveTheme({ ...CUSTOM, customFontDisplay: null, customFontBody: null })
    );

    expect(vars['--app-font-display']).toBe(NEUTRAL_FONT_STACK);
    expect(vars['--app-font-body']).toBe(NEUTRAL_FONT_STACK);
  });
});

describe('narrowCustomFontFiles', () => {
  it('keeps a well-formed map', () => {
    expect(narrowCustomFontFiles(FILES)).toEqual(FILES);
  });

  it('drops weights we never fetch and values that are not URLs', () => {
    expect(
      narrowCustomFontFiles({ display: { '400': 'https://a', '900': 'https://b', '600': 42 } })
    ).toEqual({ display: { '400': 'https://a' } });
  });

  it('drops a slot that is not an object', () => {
    expect(narrowCustomFontFiles({ display: 'https://a', body: { '400': 'https://b' } })).toEqual({
      body: { '400': 'https://b' },
    });
  });

  it('returns an empty map for anything that is not a map at all', () => {
    expect(narrowCustomFontFiles(null)).toEqual({});
    expect(narrowCustomFontFiles('nope')).toEqual({});
    expect(narrowCustomFontFiles([])).toEqual({});
  });
});
