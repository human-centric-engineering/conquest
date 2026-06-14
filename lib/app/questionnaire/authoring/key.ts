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

/**
 * Max number of content words kept in a derived key. A whole prompt slugified is a
 * mouthful (`how_would_you_describe_your_current_morale_at_work`); keeping the first
 * few content words yields the concise, scannable keys the editor expects
 * (`describe_current_morale_work`). Authors who want an exact key still pass one
 * explicitly (the route honours it verbatim); this only shapes the *derived* default.
 */
const MAX_KEY_WORDS = 4;

/** Fallback when a prompt has no slug-able characters (e.g. only punctuation). */
const FALLBACK_KEY = 'question';

/** Combining diacritical marks, stripped after NFKD normalisation. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Grammatical function words dropped when deriving a key so the slug keeps the
 * *meaningful* nouns/verbs, not the scaffolding of a question. Interrogatives,
 * articles, pronouns, auxiliaries/copulas, and the most common prepositions/
 * conjunctions — intentionally conservative (no content verbs/nouns), so a key
 * never loses its subject. Lowercase; matched word-for-word after tokenisation.
 */
const STOPWORDS = new Set([
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'how',
  'is',
  'are',
  'am',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'have',
  'has',
  'had',
  'i',
  'you',
  'your',
  'yours',
  'we',
  'our',
  'ours',
  'they',
  'their',
  'theirs',
  'he',
  'she',
  'it',
  'its',
  'his',
  'her',
  'hers',
  'my',
  'mine',
  'me',
  'us',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'as',
  'and',
  'or',
  'but',
  'if',
  'that',
  'this',
  'these',
  'those',
  'please',
]);

/**
 * Derive a concise `snake_case` ascii slug from a question prompt: lowercase, strip
 * accents, tokenise, drop grammatical {@link STOPWORDS}, and keep the first
 * {@link MAX_KEY_WORDS} content words (so `"How would you describe your current morale
 * at work?"` → `describe_current_morale_work`, not the whole sentence). When the prompt
 * is *all* stopwords (e.g. `"How are you?"`) it falls back to the leading raw words so a
 * key is never empty. Truncates to {@link MAX_KEY_LENGTH}; returns {@link FALLBACK_KEY}
 * when nothing slug-able remains.
 */
export function slugifyKey(prompt: string): string {
  const words = prompt
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const content = words.filter((w) => !STOPWORDS.has(w));
  // Keep the meaningful words; if a prompt is nothing but stopwords, keep the raw ones
  // rather than emit the bare fallback (those words are still better than `question`).
  const chosen = (content.length > 0 ? content : words).slice(0, MAX_KEY_WORDS);

  const slug = chosen.join('_').slice(0, MAX_KEY_LENGTH).replace(/_+$/g, ''); // re-trim if truncation split mid-word
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
