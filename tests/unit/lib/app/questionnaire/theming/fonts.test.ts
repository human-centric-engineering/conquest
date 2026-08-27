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
  NEUTRAL_FONT_STACK,
} from '@/lib/app/questionnaire/theming';

const ROOT_LAYOUT = readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf8');
const BRAND_THEME_CSS = readFileSync(join(process.cwd(), 'app/brand-theme.css'), 'utf8');

/** Every `var(--…)` a stack reaches for. */
function variablesIn(stack: string): string[] {
  return [...stack.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
}

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
    const referenced = FONT_PAIRINGS.filter((p) => p !== DEFAULT_FONT_PAIRING).flatMap((p) => [
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
    // Four typefaces nobody on a marketing page will use. Every next/font call that declares
    // a --font-brand-* variable must opt out, or every page in the product pays for them.
    const brandFontBlocks = ROOT_LAYOUT.split('const ').filter((block) =>
      block.includes("variable: '--font-brand-")
    );
    expect(brandFontBlocks.length).toBe(4);
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
        expect(stack).toMatch(/(sans-serif|serif)\s*$/);
      }
    }
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
