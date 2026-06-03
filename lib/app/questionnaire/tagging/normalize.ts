/**
 * Tag label normalisation (F2.2).
 *
 * Every `AppQuestionTag` stores both the admin-entered `label` (shown verbatim)
 * and a `normalizedLabel` — the case-insensitive dedup key the DB enforces unique
 * per version (`@@unique([versionId, normalizedLabel])`). Normalising to
 * trim + collapse-internal-whitespace + lowercase means "Pricing", "  pricing  "
 * and "PRICING" all collide, so the vocabulary can't accumulate near-duplicates
 * that differ only by case or stray spaces.
 *
 * Pure: string-only, no Prisma / Next — mirrors `authoring/key.ts`'s `slugifyKey`.
 * The DB collision (P2002) is mapped to a 400 in the route; this is the in-memory
 * key both the writer and the unit tests compute.
 */

/**
 * Trim, collapse internal whitespace runs to a single space, and lowercase.
 * Diacritics are preserved (a tag label is human display text, unlike a question
 * `key` slug) — only case and surrounding/repeated whitespace are folded.
 */
export function normalizeTagLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}
