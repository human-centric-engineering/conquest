/**
 * Unit tests: matching a site's typefaces to a pairing we can render.
 *
 * The rule worth pinning is the last one: an unplaceable family resolves to NOTHING, not to
 * `neutral`. `neutral` is a real choice an admin may have made deliberately, so proposing it as a
 * fallback would overwrite a decision with a value we never measured.
 */

import { describe, it, expect } from 'vitest';

import { matchFontPairing } from '@/lib/app/questionnaire/brand-import/font-match';

describe('matchFontPairing', () => {
  it('matches a face we actually ship, and says the match was exact', () => {
    expect(matchFontPairing(['Space Grotesk'])).toEqual({
      pairing: 'contemporary',
      family: 'Space Grotesk',
      how: 'exact',
    });
  });

  it('is case- and whitespace-insensitive, because a Fonts link is neither', () => {
    expect(matchFontPairing(['  playfair display '])?.pairing).toBe('classical');
  });

  it('prefers an exact match anywhere in the list over an earlier shape match', () => {
    // A site that loads Space Grotesk should get Contemporary even when its body stack mentions
    // Georgia first — the loaded face is the deliberate choice.
    const match = matchFontPairing(['Georgia', 'Space Grotesk']);
    expect(match).toEqual({ pairing: 'contemporary', family: 'Space Grotesk', how: 'exact' });
  });

  it('places an unfamiliar family by the shape its name implies, and marks it a guess', () => {
    expect(matchFontPairing(['Poppins'])).toEqual({
      pairing: 'humanist',
      family: 'Poppins',
      how: 'shape',
    });
    expect(matchFontPairing(['Roboto Mono'])?.pairing).toBe('monospace');
    expect(matchFontPairing(['Canela Deck'])?.pairing).toBe('classical');
  });

  it('tests monospace before the sans rules, so a mono grotesque is not read as a grotesque', () => {
    expect(matchFontPairing(['IBM Plex Mono'])?.pairing).toBe('monospace');
  });

  it('returns null when nothing places, rather than falling back to neutral', () => {
    expect(matchFontPairing(['Wingdings'])).toBeNull();
    expect(matchFontPairing([])).toBeNull();
  });
});
