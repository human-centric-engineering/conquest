/**
 * The design axis is a stylesheet, so the stylesheet is what has to be asserted.
 *
 * Every other setting on the respondent surface is enforced by the compiler somewhere: a layout has
 * a registry entry `satisfies` checks, a chrome mode has a branch in a component, a scope has a
 * narrowing helper. A DESIGN has none of that. It is an attribute value and a block of CSS, and the
 * two are joined by a string. Nothing in TypeScript can notice when they stop matching, and the
 * failure is silent by construction — an attribute matching no block does not throw, it renders the
 * platform's own corners and looks *almost* right.
 *
 * So these tests do the joining. They read the real stylesheet and the real components, and assert
 * the things that would otherwise only be found by an admin choosing a design and wondering why
 * nothing changed:
 *
 *   1. Every design name has a block.
 *   2. Every block belongs to a design name.
 *   3. Every class the stylesheet hooks is still on the component that draws it.
 *   4. The default design is genuinely a no-op.
 *
 * @see app/respondent-design.css
 * @see lib/app/questionnaire/types.ts — RESPONDENT_DESIGNS
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { RESPONDENT_DESIGNS, DEFAULT_RESPONDENT_DESIGN } from '@/lib/app/questionnaire/types';
import { RESPONDENT_DESIGN_META } from '@/lib/app/questionnaire/layout/catalog';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'app/respondent-design.css'), 'utf8');

/** The stylesheet with its comments removed — selectors only, so prose cannot satisfy a test. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('every design has a block, and every block has a design', () => {
  it.each(RESPONDENT_DESIGNS)('`%s` is styled', (design) => {
    expect(RULES).toContain(`[data-design='${design}']`);
  });

  it('declares no selector for a design that does not exist', () => {
    // The direction the loop above cannot catch: a design REMOVED from the tuple leaves dead rules
    // behind, and dead rules are how the next person concludes a name is supported when it is not.
    const declared = new Set(
      Array.from(RULES.matchAll(/\[data-design='([a-z_]+)'\]/g), (m) => m[1])
    );
    expect([...declared].sort()).toEqual([...RESPONDENT_DESIGNS].sort());
  });

  it('names every design in the admin-facing catalog too', () => {
    // A design nobody can pick is not shipped. The catalog is what the picker and the exported
    // settings table both read.
    expect(Object.keys(RESPONDENT_DESIGN_META).sort()).toEqual([...RESPONDENT_DESIGNS].sort());
  });
});

describe('the default design is a no-op', () => {
  it('declares nothing but comments', () => {
    // The load-bearing promise of the whole axis: a questionnaire that never touches this setting
    // renders what it always did. The cheapest way to guarantee that is for the default's block to
    // contain no declarations at all, so this asserts exactly that rather than trusting the prose.
    const block = new RegExp(
      `\\[data-design='${DEFAULT_RESPONDENT_DESIGN}'\\]\\s*\\{([^}]*)\\}`
    ).exec(RULES);
    expect(block).not.toBeNull();
    expect(block![1].trim()).toBe('');
  });

  it('is not named in any multi-design selector either', () => {
    // The shared "straight lines" block lists `press` and `marque` by name. If the default were
    // ever added to one of those lists the block above could stay empty while the default design
    // still changed — which is the same regression, arriving by the other door.
    // Matched on the SELECTOR, not on the bare word: the default is called `rounded` and the
    // stylesheet also flattens Tailwind's `.rounded-full`, so a substring test finds the utility
    // class and reports a design that is not there. (It did, the first time this ran.)
    const selector = `[data-design='${DEFAULT_RESPONDENT_DESIGN}']`;
    for (const line of RULES.split('\n')) {
      if (!line.includes(selector)) continue;
      // The only legal appearance is the default's own block selector, alone on its line.
      expect(line.trim()).toBe(`${selector} {`);
    }
  });
});

describe('the class hooks the stylesheet reaches for still exist', () => {
  /**
   * A design styles components it does not own, through classes those components carry. Rename one
   * — `cq-turn-mark` to `cq-interviewer-mark`, say — and TypeScript is perfectly happy while
   * `marque` quietly stops putting the client's logo beside their questions.
   *
   * Each entry is the class, and the file that must still be applying it.
   */
  const HOOKS: Array<[string, string]> = [
    ['cq-turn-mark', 'components/app/questionnaire/chat/transcript-turns.tsx'],
    ['cq-user-bubble', 'components/app/questionnaire/chat/transcript-turns.tsx'],
    ['cq-conversation-frame', 'components/app/questionnaire/chat/conversation-frame.tsx'],
    ['cq-composer', 'components/app/questionnaire/chat/chat-composer.tsx'],
  ];

  it.each(HOOKS)('`%s` is both styled here and applied in %s', (cls, file) => {
    expect(RULES).toContain(`.${cls}`);
    expect(readFileSync(join(ROOT, file), 'utf8')).toContain(cls);
  });

  it('reads the brand variables rather than hard-coding a colour', () => {
    // A design that painted a literal hex would look the same for every client, which for `marque`
    // — whose entire argument is that the brand becomes structure — would be the feature failing
    // while appearing to work. Only the neutral `color-mix` over `--color-foreground` is exempt:
    // those tune the hairlines, which are ConQuest's, not the client's.
    const accentRules = RULES.split('\n').filter((l) => /border-|background/.test(l));
    const hardCoded = accentRules.filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l));
    expect(hardCoded).toEqual([]);
  });
});

describe('the mechanism the file claims to rely on', () => {
  it('uses no `!important`', () => {
    // The header states the rules are unlayered and therefore beat Tailwind's utilities on layer
    // order alone. An `!important` creeping in would mean that claim had quietly stopped being
    // true, and the next person would copy the workaround rather than the mechanism.
    expect(RULES).not.toContain('!important');
  });

  it('is not wrapped in a `@layer`', () => {
    // Wrapping it would put these rules back in the cascade alongside the utilities they exist to
    // override, and every corner reset in the file would silently stop applying.
    expect(RULES).not.toMatch(/@layer/);
  });

  it('keeps focus rings out of the shadow reset', () => {
    // Tailwind draws focus rings as box-shadows. The reset that removes resting lift must exclude
    // the focused state, or the designs ship an accessibility regression wearing an aesthetic.
    const shadowResets = RULES.split('}')
      .filter((block) => /box-shadow:\s*none/.test(block))
      .filter((block) => /\.shadow/.test(block));
    expect(shadowResets.length).toBeGreaterThan(0);
    for (const block of shadowResets) {
      expect(block).toContain(':not(:focus-visible)');
    }
  });
});
