/**
 * Brand import — map the typefaces a site uses onto a pairing we can render.
 *
 * A site tells us its faces by name (`Playfair Display`, `Space Grotesk`). We ship six pairings and
 * — from phase 3 — a custom option that self-hosts an arbitrary Google family. This decides which
 * of those to propose.
 *
 * Two tiers, and the difference is reported rather than hidden:
 *
 *  - **An exact face match.** The site uses one of the ten faces our pairings are built from, so
 *    proposing that pairing reproduces the brand rather than approximating it.
 *  - **A shape match.** The site uses something else, and the family's NAME tells us roughly what
 *    kind of thing it is — a Didone serif, a grotesque, a monospace. This is a guess and is marked
 *    as one.
 *
 * Anything we cannot place resolves to nothing, not to `neutral`. `neutral` is a real choice an
 * admin may have made deliberately, and proposing it as a fallback would overwrite that with a
 * value we did not actually measure — the same mistake as filling a colour field with a default.
 */

import { FONT_PAIRINGS, type FontPairing } from '@/lib/app/questionnaire/theming';

/**
 * The faces each SHIPPED pairing loads, as a site would name them in CSS or a Fonts link.
 *
 * `neutral` and `custom` are both absent, for opposite reasons: neutral loads nothing, and custom
 * loads whatever the client named — so neither has a fixed face list to match against.
 */
const PAIRING_FACES: Record<Exclude<FontPairing, 'neutral' | 'custom'>, string[]> = {
  editorial: ['instrument serif', 'newsreader'],
  contemporary: ['bricolage grotesque', 'space grotesk'],
  humanist: ['outfit', 'source sans 3', 'source sans pro'],
  classical: ['playfair display', 'lora'],
  monospace: ['jetbrains mono', 'ibm plex mono'],
};

/**
 * Name patterns that place an unfamiliar family by shape.
 *
 * Order matters: monospace is tested first because `IBM Plex Mono` would otherwise match nothing
 * and `Roboto Mono` would read as a grotesque. Classical before editorial because a high-contrast
 * display serif is the more specific claim.
 */
const SHAPE_RULES: { pairing: Exclude<FontPairing, 'neutral' | 'custom'>; pattern: RegExp }[] = [
  { pairing: 'monospace', pattern: /\b(?:mono|code|courier|consolas|menlo)\b/i },
  {
    pairing: 'classical',
    pattern: /\b(?:playfair|didot|bodoni|baskerville|garamond|canela|tiempos)\b/i,
  },
  {
    pairing: 'editorial',
    pattern: /\b(?:serif|georgia|times|merriweather|lora|newsreader|spectral|source serif)\b/i,
  },
  {
    pairing: 'contemporary',
    pattern: /\b(?:grotesk|grotesque|druk|neue haas|suisse|aeonik|graphik)\b/i,
  },
  {
    pairing: 'humanist',
    pattern:
      /\b(?:inter|outfit|nunito|karla|rubik|work sans|open sans|lato|poppins|manrope|dm sans)\b/i,
  },
];

export interface FontMatch {
  pairing: FontPairing;
  /** The family name that produced the match — shown to the admin as the reason. */
  family: string;
  /** `exact` when the site uses a face we actually ship; `shape` when we placed it by name. */
  how: 'exact' | 'shape';
}

/**
 * Choose a pairing from the families a site uses, or null when none of them place.
 *
 * Families arrive most-likely-first (a Google Fonts link outranks a `font-family` stack), and the
 * first EXACT match wins outright over any shape match — a site that loads Space Grotesk should get
 * Contemporary even if its body stack happens to mention Georgia further down.
 */
export function matchFontPairing(families: string[]): FontMatch | null {
  for (const family of families) {
    const normalised = family.trim().toLowerCase();
    for (const pairing of FONT_PAIRINGS) {
      if (pairing === 'neutral' || pairing === 'custom') continue;
      if (PAIRING_FACES[pairing].includes(normalised)) {
        return { pairing, family: family.trim(), how: 'exact' };
      }
    }
  }

  for (const family of families) {
    for (const rule of SHAPE_RULES) {
      if (rule.pattern.test(family)) {
        return { pairing: rule.pairing, family: family.trim(), how: 'shape' };
      }
    }
  }

  return null;
}
