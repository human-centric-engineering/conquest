import { describe, it, expect } from 'vitest';

import {
  EXPERIENCE_CONTINUITY_MODE_LABELS,
  EXPERIENCE_CONTINUITY_MODES,
  EXPERIENCE_KIND_DESCRIPTIONS,
  EXPERIENCE_KIND_LABELS,
  EXPERIENCE_KINDS,
  EXPERIENCE_ROUTING_FALLBACK_LABELS,
  EXPERIENCE_ROUTING_FALLBACKS,
  EXPERIENCE_STEP_KEY_MAX_LENGTH,
  EXPERIENCE_STEP_KIND_LABELS,
  EXPERIENCE_STEP_KINDS,
  slugifyStepKey,
} from '@/lib/app/questionnaire/experiences/types';

/**
 * The const tuples are the single source of truth for every Experience vocabulary — Zod enums,
 * `narrowToEnum` fallbacks, and the admin selects all derive from them. A member added to a tuple
 * without a label would render as blank in a dropdown, so the label maps are checked for
 * exhaustiveness here rather than discovered in the UI.
 */
describe('experience vocabularies', () => {
  it('labels every kind, continuity mode, fallback and step kind', () => {
    for (const kind of EXPERIENCE_KINDS) {
      expect(EXPERIENCE_KIND_LABELS[kind]).toBeTruthy();
      expect(EXPERIENCE_KIND_DESCRIPTIONS[kind]).toBeTruthy();
    }
    for (const mode of EXPERIENCE_CONTINUITY_MODES) {
      expect(EXPERIENCE_CONTINUITY_MODE_LABELS[mode]).toBeTruthy();
    }
    for (const fallback of EXPERIENCE_ROUTING_FALLBACKS) {
      expect(EXPERIENCE_ROUTING_FALLBACK_LABELS[fallback]).toBeTruthy();
    }
    for (const kind of EXPERIENCE_STEP_KINDS) {
      expect(EXPERIENCE_STEP_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it('defaults the routing fallback vocabulary to conclude-first ordering', () => {
    // `conclude` is the documented default and the honest failure mode. Keeping it first also
    // makes it the natural first option in any select built by mapping the tuple.
    expect(EXPERIENCE_ROUTING_FALLBACKS[0]).toBe('conclude');
  });

  it('keeps linked and stitched adjacent, with merged last', () => {
    // `linked` and `stitched` share a persistence shape; `merged` does not. The ordering encodes
    // that, and `merged` being last is what lets it be dropped without renumbering anything.
    expect([...EXPERIENCE_CONTINUITY_MODES]).toEqual(['linked', 'stitched', 'merged']);
  });
});

describe('slugifyStepKey', () => {
  it('lowercases and kebab-cases a title', () => {
    expect(slugifyStepKey('Deep dive: pricing')).toBe('deep-dive-pricing');
    expect(slugifyStepKey('Opening Questions')).toBe('opening-questions');
  });

  it('collapses runs of punctuation and whitespace into single hyphens', () => {
    expect(slugifyStepKey('A  --  B')).toBe('a-b');
    expect(slugifyStepKey('what?! now')).toBe('what-now');
  });

  it('strips leading and trailing separators', () => {
    expect(slugifyStepKey('  -- hello --  ')).toBe('hello');
  });

  it('falls back to "step" when a title slugifies to nothing', () => {
    // A title of only punctuation or non-Latin script would otherwise yield an empty key, which
    // the selector could not name. The caller de-duplicates the fallback against siblings.
    expect(slugifyStepKey('!!!')).toBe('step');
    expect(slugifyStepKey('   ')).toBe('step');
    expect(slugifyStepKey('日本語')).toBe('step');
  });

  it('caps the key length without leaving a trailing hyphen', () => {
    // A naive slice can land mid-separator and produce "foo-bar-", which fails the kebab-case
    // regex the update route validates against.
    const key = slugifyStepKey('a'.repeat(40) + ' ' + 'b'.repeat(40));

    expect(key.length).toBeLessThanOrEqual(EXPERIENCE_STEP_KEY_MAX_LENGTH);
    expect(key.endsWith('-')).toBe(false);
    expect(key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('always produces a key the step schema will accept', () => {
    const titles = [
      'Deep dive: pricing',
      '  Leading spaces',
      'Trailing spaces  ',
      'Numbers 123 in the middle',
      'MIXED Case With CAPS',
    ];
    for (const title of titles) {
      expect(slugifyStepKey(title)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});
