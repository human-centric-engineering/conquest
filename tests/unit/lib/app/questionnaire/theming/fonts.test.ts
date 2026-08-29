/**
 * The font pairings, and the one thing about them that nothing else can catch.
 *
 * `FONT_PAIRING_STACKS` names its faces through CSS custom properties — `var(--font-brand-
 * editorial-display)` — which `app/layout.tsx` declares by calling `next/font` with matching
 * `variable` names. Nothing links the two ends: TypeScript never sees inside the string, and
 * a mismatch does not throw. It renders in the fallback face, which looks like a deliberate
 * choice rather than a bug, on a surface an admin only reaches through a demo client.
 *
 * So the layout is read as TEXT here, and the variable names are checked against each other.
 * A rename on either side fails this test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_FONT_PAIRING,
  FONT_PAIRINGS,
  FONT_PAIRING_COPY,
  FONT_PAIRING_STACKS,
  MONO_FONT_STACK,
  NEUTRAL_FONT_STACK,
  customFontFaceId,
  customFontStacks,
  isCustomFontFamily,
  resolveCustomFontFamily,
} from '@/lib/app/questionnaire/theming';

const ROOT_LAYOUT = readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf8');
const BRAND_THEME_CSS = readFileSync(join(process.cwd(), 'app/brand-theme.css'), 'utf8');

/** Every `var(--…)` a stack reaches for. */
function variablesIn(stack: string): string[] {
  return [...stack.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
}

/**
 * The pairings whose faces this build LOADS — i.e. everything the `next/font` parity below is
 * about.
 *
 * `neutral` is excluded because it is the system stack and loads nothing. `custom` is excluded
 * because its faces are per-client: they are fetched from Google Fonts at configuration time,
 * stored, and served from our own origin as `@font-face` rules, so there is no build-time variable
 * for the layout to declare and nothing here to check. Both exclusions are structural, not
 * waivers — a shipped pairing that stopped declaring a variable would still fail.
 */
const BUILD_LOADED_PAIRINGS = FONT_PAIRINGS.filter(
  (pairing) => pairing !== DEFAULT_FONT_PAIRING && pairing !== 'custom'
);

describe('font pairings', () => {
  it('declares copy and a stack for every pairing', () => {
    for (const pairing of FONT_PAIRINGS) {
      expect(FONT_PAIRING_STACKS[pairing]).toBeDefined();
      expect(FONT_PAIRING_COPY[pairing].label).not.toBe('');
      expect(FONT_PAIRING_COPY[pairing].description).not.toBe('');
    }
  });

  it('is the system stack for the default pairing, so an unset client changes nothing', () => {
    const neutral = FONT_PAIRING_STACKS[DEFAULT_FONT_PAIRING];
    expect(neutral.display).toBe(NEUTRAL_FONT_STACK);
    expect(neutral.body).toBe(NEUTRAL_FONT_STACK);
  });

  it('loads every font variable the non-default stacks reference in the root layout', () => {
    // The parity check this file exists for.
    const referenced = BUILD_LOADED_PAIRINGS.flatMap((p) => [
      ...variablesIn(FONT_PAIRING_STACKS[p].display),
      ...variablesIn(FONT_PAIRING_STACKS[p].body),
    ]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const variable of referenced) {
      expect(ROOT_LAYOUT, `${variable} is not declared in app/layout.tsx`).toContain(
        `variable: '${variable}'`
      );
    }
  });

  it('keeps the brand faces out of the preload set', () => {
    // Typefaces nobody on a marketing page will use. Every next/font call that declares a
    // --font-brand-* variable must opt out, or every page in the product pays for them — and
    // that cost is what makes the pairing list safe to grow, so the count is DERIVED from
    // BUILD_LOADED_PAIRINGS (two faces each) rather than written down. A new pairing whose faces
    // are preloaded, or which forgets one of its two declarations, fails here.
    const brandFontBlocks = ROOT_LAYOUT.split('const ').filter((block) =>
      block.includes("variable: '--font-brand-")
    );
    expect(brandFontBlocks.length).toBe(BUILD_LOADED_PAIRINGS.length * 2);
    for (const block of brandFontBlocks) {
      expect(block).toContain('preload: false');
    }
  });

  it('ends every stack in a face the browser certainly has', () => {
    // The variables above resolve to nothing until the font actually loads, so each stack
    // needs a real generic at the end — otherwise a slow network renders the questionnaire
    // in the browser's default serif rather than in something chosen.
    for (const pairing of FONT_PAIRINGS) {
      for (const stack of [
        FONT_PAIRING_STACKS[pairing].display,
        FONT_PAIRING_STACKS[pairing].body,
      ]) {
        expect(stack).toMatch(/(sans-serif|serif|monospace)\s*$/);
      }
    }
  });

  it('tails the monospace pairing in a fixed-width generic, not the neutral sans', () => {
    // The one place the generic actually matters. Both mono stacks lead with a webfont that
    // arrives late; if they fell back to NEUTRAL_FONT_STACK the questionnaire would render
    // proportional and then REFLOW to fixed-width mid-read. Ending in MONO_FONT_STACK makes
    // the swap fixed-width → fixed-width, which barely moves.
    for (const stack of [
      FONT_PAIRING_STACKS.monospace.display,
      FONT_PAIRING_STACKS.monospace.body,
    ]) {
      expect(stack).toContain(MONO_FONT_STACK);
      expect(stack).not.toContain(NEUTRAL_FONT_STACK);
    }
  });

  it('gives every pairing its own faces, so the picker is a real choice at every step', () => {
    // The setting exists so a prospect can tell their questionnaire apart from the last one.
    // Two pairings sharing a face would make one of them redundant on screen while still
    // costing a download — so no --font-brand-* variable may appear in two pairings.
    const seen = new Map<string, string>();
    for (const pairing of BUILD_LOADED_PAIRINGS) {
      for (const stack of [
        FONT_PAIRING_STACKS[pairing].display,
        FONT_PAIRING_STACKS[pairing].body,
      ]) {
        for (const variable of variablesIn(stack)) {
          expect(seen.get(variable), `${variable} is shared with ${seen.get(variable)}`).toBe(
            undefined
          );
          seen.set(variable, pairing);
        }
      }
    }
    // Two faces per build-loaded pairing, all distinct.
    expect(seen.size).toBe(BUILD_LOADED_PAIRINGS.length * 2);
  });

  it('has a stylesheet default for both font variables, so neutral needs no inline style', () => {
    // themeToCssVariables emits nothing for `neutral`; these two declarations are what make
    // that safe rather than a surface with no font-family at all.
    expect(BRAND_THEME_CSS).toContain('--app-font-display:');
    expect(BRAND_THEME_CSS).toContain('--app-font-body:');
    expect(BRAND_THEME_CSS).toContain('font-family: var(--app-font-body)');
    expect(BRAND_THEME_CSS).toContain('font-family: var(--app-font-display)');
  });
});

describe('custom type', () => {
  it('renders the system stack when the option is chosen but no family is set yet', () => {
    // Not an error state to guard against: it is what the row looks like between choosing the
    // option and loading the faces, and the system stack is the right thing to show meanwhile.
    expect(FONT_PAIRING_STACKS.custom.display).toBe(NEUTRAL_FONT_STACK);
    expect(FONT_PAIRING_STACKS.custom.body).toBe(NEUTRAL_FONT_STACK);
  });

  it('leads each stack with the family and falls back to the system stack', () => {
    const stacks = customFontStacks('Poppins', 'Karla');

    expect(stacks.display).toBe(`'Poppins', ${NEUTRAL_FONT_STACK}`);
    expect(stacks.body).toBe(`'Karla', ${NEUTRAL_FONT_STACK}`);
  });

  it('renders sensibly when only one slot is set', () => {
    const stacks = customFontStacks('Poppins', null);

    expect(stacks.display).toContain('Poppins');
    expect(stacks.body).toBe(NEUTRAL_FONT_STACK);
  });

  it('cannot emit a quote that would break out of the font-family value', () => {
    // The stack is interpolated into CSS, so a family carrying an apostrophe must not be able to
    // terminate the quoted name and start a new declaration.
    expect(customFontStacks("Ac'me", null).display).not.toContain("Ac'me");
  });

  it('accepts the punctuation real family names use, and nothing that reaches a URL', () => {
    expect(isCustomFontFamily('Space Grotesk')).toBe(true);
    expect(isCustomFontFamily('IBM Plex Sans')).toBe(true);
    // Each of these is a way to reach a different path or smuggle a second query parameter into
    // the Google Fonts request we build server-side.
    expect(isCustomFontFamily('Inter/../../etc')).toBe(false);
    expect(isCustomFontFamily('Inter&text=x')).toBe(false);
    expect(isCustomFontFamily('Inter:wght@400')).toBe(false);
    expect(isCustomFontFamily('%2e%2e')).toBe(false);
    expect(isCustomFontFamily('')).toBe(false);
  });

  it('is forgiving on read, so a bad stored value falls back rather than breaking the page', () => {
    expect(resolveCustomFontFamily('  Poppins ')).toBe('Poppins');
    expect(resolveCustomFontFamily('Inter&text=x')).toBeNull();
    expect(resolveCustomFontFamily(null)).toBeNull();
    expect(resolveCustomFontFamily('')).toBeNull();
  });

  it('addresses a stored face by slot and weight', () => {
    expect(customFontFaceId('display', 700)).toBe('display-700');
  });
});
