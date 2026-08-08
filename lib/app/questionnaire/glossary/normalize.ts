/**
 * Glossary surface normalisation — the single source of "are these the same term?" (P16).
 *
 * Three consumers share this function, and they MUST agree:
 *   1. `AppGlossaryTerm.normalizedTerm`, the per-version uniqueness key;
 *   2. `saveGlossarySchema`'s duplicate check, which rejects a save before it reaches the DB;
 *   3. the respondent-facing matcher's index, which decides what gets underlined.
 *
 * If (1) and (3) drifted apart you would get a term the admin cannot save twice but which never
 * matches, or vice versa. Hence one function, no local variants.
 *
 * Pure — no Prisma, no React.
 */

/**
 * Fold a term or alias to its canonical comparison form.
 *
 * - lowercased, so `Ego` and `ego` are one term;
 * - curly apostrophes and the modifier-letter apostrophe folded to `'`, because a term typed in
 *   Word ("respondent's self") must match the same term typed in a browser;
 * - every hyphen and dash variant folded to a space, so `higher-self` ≡ `higher self` — this is
 *   the single most common way the same term appears in two forms in one document;
 * - runs of whitespace collapsed and the result trimmed.
 *
 * Deliberately NOT done: accent stripping (a term that differs only by accent is a different
 * word in most languages) and stemming (see `matcher.ts` — "egoism" is not "ego").
 */
export function normalizeGlossarySurface(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[-‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
