/**
 * Question `key` slug helpers (F2.1 / PR2).
 *
 * Every `AppQuestionSlot` carries a stable per-version `key` (answers and
 * re-ingest reference it, not the cuid). The DB enforces `@@unique([versionId,
 * key])`. When an admin adds a question without supplying a key, we derive one
 * from the prompt and disambiguate against the keys already taken in that
 * version. When the admin supplies an explicit key, the route honours it and lets
 * a collision surface as a 400 (we never silently mutate an admin-chosen key).
 *
 * Pure: string-only, no Prisma / Next. The DB collision retry (P2002) lives in
 * the route; `nextAvailableKey` is the in-memory counterpart used both by the
 * writer (seeded from the version's existing keys) and by unit tests.
 */

/** Max slug length — keeps keys readable and well under any column limit. */
const MAX_KEY_LENGTH = 60;

/** Fallback when a prompt has no slug-able characters (e.g. only punctuation). */
const FALLBACK_KEY = 'question';

/** Combining diacritical marks, stripped after NFKD normalisation. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Derive a `snake_case` ascii slug from a question prompt: lowercase, strip
 * accents, collapse any run of non-alphanumerics to a single `_`, trim leading/
 * trailing `_`, and truncate to {@link MAX_KEY_LENGTH}. Returns {@link FALLBACK_KEY}
 * when nothing slug-able remains.
 */
export function slugifyKey(prompt: string): string {
  const slug = prompt
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY_LENGTH)
    .replace(/_+$/g, ''); // re-trim if truncation left a trailing _
  return slug.length > 0 ? slug : FALLBACK_KEY;
}

/**
 * Return `base` if free, else the first `base_2`, `base_3`, … not in `taken`.
 * Suffixing respects {@link MAX_KEY_LENGTH} by trimming the base so the suffix
 * always fits. Pure — the caller seeds `taken` with the version's existing keys.
 */
export function nextAvailableKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const trimmed = base.slice(0, MAX_KEY_LENGTH - suffix.length).replace(/_+$/g, '');
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
