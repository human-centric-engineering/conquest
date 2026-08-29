// @vitest-environment happy-dom

/**
 * Pinning a respondent surface to one mode — asserted by RESOLVING the cascade, not by matching
 * selector text.
 *
 * The admin brand preview renders the same client light AND dark at once. Every other respondent
 * surface follows `<html>.dark`, and two panels on one page cannot both do that, so `data-scheme`
 * overrides it. The override lives entirely in `app/brand-theme.css`, and it works only because of
 * a specificity argument:
 *
 *   - the dark block carries `:not([data-scheme='light'])`, so a light-pinned panel inside
 *     `<html>.dark` stops matching it and falls through to the unscoped light block;
 *   - `[data-surface='respondent'][data-scheme='dark']` outweighs that unscoped light block, so a
 *     dark-pinned panel goes dark with no `.dark` ancestor at all.
 *
 * A text assertion cannot check either half — it would pass on a stylesheet whose specificity was
 * upside down. So these tests load the REAL rule blocks into a document and read the computed
 * value back. That matters because the failure is silent in the worst way: both panels still
 * render, both in the viewer's own mode, looking exactly like a working comparison.
 *
 * @see app/brand-theme.css
 * @see components/admin/demo-clients/demo-client-theme-preview.tsx
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach } from 'vitest';

import { NEUTRAL_RESPONDENT_GROUND } from '@/lib/app/questionnaire/theming';

const BRAND_THEME_CSS = readFileSync(join(process.cwd(), 'app/brand-theme.css'), 'utf8');

/**
 * Lift one rule block out of the real stylesheet, by the exact text of its selector.
 *
 * Throwing on a miss is half the point: a renamed or deleted selector fails here rather than
 * quietly producing a document with no rule in it, which would "pass" every assertion below by
 * resolving everything to the same empty string.
 */
function ruleBlock(selector: string): string {
  const start = BRAND_THEME_CSS.indexOf(selector);
  if (start === -1) throw new Error(`app/brand-theme.css no longer contains: ${selector}`);
  const end = BRAND_THEME_CSS.indexOf('}', start);
  return BRAND_THEME_CSS.slice(start, end + 1);
}

/**
 * The blocks that decide a respondent surface's ground, and nothing else.
 *
 * Deliberately not the whole stylesheet: it is Tailwind 4 source with `@theme` and `@layer`, which
 * a bare document cannot interpret. These four blocks are plain CSS custom properties, they are the
 * ones the pinning argument is about, and they are read verbatim so a rename breaks the test.
 */
const RULES = [
  ':root { --cq-respondent-canvas: #ffffff; }',
  '.dark { --cq-respondent-canvas: #0a0a0a; }',
  ruleBlock("[data-surface='respondent'][data-scheme='light'] {"),
  ruleBlock("[data-surface='respondent'][data-scheme='dark'] {"),
  ruleBlock("[data-surface='respondent'] {\n  --color-primary: #18181b"),
  ruleBlock(".dark [data-surface='respondent']:not([data-scheme='light']),"),
].join('\n');

/** Render three panels under a given root mode and read each one's resolved ground. */
function grounds(rootClass: '' | 'dark'): Record<string, string> {
  document.documentElement.className = rootClass;
  document.head.innerHTML = `<style>${RULES}</style>`;
  document.body.innerHTML = `
    <div id="light" data-surface="respondent" data-scheme="light"></div>
    <div id="dark" data-surface="respondent" data-scheme="dark"></div>
    <div id="unpinned" data-surface="respondent"></div>
  `;

  const read = (id: string): string =>
    getComputedStyle(document.getElementById(id) as Element)
      .getPropertyValue('--app-canvas-color')
      .trim();

  return { light: read('light'), dark: read('dark'), unpinned: read('unpinned') };
}

beforeEach(() => {
  document.documentElement.className = '';
});

describe('data-scheme pins a respondent surface to one mode', () => {
  it('holds a light panel light inside a dark admin', () => {
    // The half that needs `:not()`. Without it the panel matches the dark block at higher
    // specificity than the light one, and an admin working in dark mode sees two dark previews.
    expect(grounds('dark').light).toBe(NEUTRAL_RESPONDENT_GROUND.light.canvas);
  });

  it('takes a dark panel dark inside a light admin', () => {
    // The half that needs the extra attribute weight: with no `.dark` ancestor, only
    // `[data-scheme='dark']` can outrank the unscoped light block.
    expect(grounds('').dark).toBe(NEUTRAL_RESPONDENT_GROUND.dark.canvas);
  });

  it('renders both panels correctly in either admin mode', () => {
    for (const rootClass of ['', 'dark'] as const) {
      const resolved = grounds(rootClass);
      expect(resolved.light).toBe(NEUTRAL_RESPONDENT_GROUND.light.canvas);
      expect(resolved.dark).toBe(NEUTRAL_RESPONDENT_GROUND.dark.canvas);
    }
  });

  it('leaves an unpinned surface following the viewer, exactly as before', () => {
    // Every real respondent surface is unpinned. Nothing but a preview should ever contradict the
    // viewer's own mode, so this is the regression that would matter most.
    expect(grounds('').unpinned).toBe(NEUTRAL_RESPONDENT_GROUND.light.canvas);
    expect(grounds('dark').unpinned).toBe(NEUTRAL_RESPONDENT_GROUND.dark.canvas);
  });
});
