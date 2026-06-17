/**
 * Session support reference — the short, human-readable code a respondent quotes when reporting a
 * bad experience ("Ref: 7F3K-9M2P").
 *
 * Stored on `AppQuestionnaireSession.publicRef` as the raw 8-char code (no dash); the UI groups it
 * for legibility. Uses the **Crockford base32** alphabet (no I/L/O/U) so it's unambiguous read
 * aloud or typed, and lookups are forgiving — `normalizeSessionRef` folds the look-alikes a human
 * might enter (O→0, I/L→1) and strips any grouping dash or spaces.
 *
 * 32^8 ≈ 1.1e12 codes — collisions are astronomically unlikely at any realistic session volume, and
 * the `@unique` index is the backstop. Pure: no Prisma / Next.
 */

import { customAlphabet } from 'nanoid';

/** Crockford base32 — digits + uppercase letters, excluding I, L, O, U. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Code length (characters, before grouping). 8 → one dash-separated pair of quads. */
export const SESSION_REF_LENGTH = 8;

const make = customAlphabet(CROCKFORD_ALPHABET, SESSION_REF_LENGTH);

/** Generate a new raw session ref (8 Crockford base32 chars, e.g. `7F3K9M2P`). */
export function generateSessionRef(): string {
  return make();
}

/** Group a raw ref for display: `7F3K9M2P` → `7F3K-9M2P`. Non-8-char input is returned uppercased. */
export function formatSessionRef(raw: string): string {
  const s = raw.toUpperCase();
  return s.length === SESSION_REF_LENGTH ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/**
 * Normalise user-entered ref text for lookup: uppercase, drop grouping dashes/spaces, and fold the
 * Crockford look-alikes a human commonly mistypes (`O`→`0`, `I`/`L`→`1`). Returns the canonical raw
 * form to match against `publicRef`.
 */
export function normalizeSessionRef(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}
