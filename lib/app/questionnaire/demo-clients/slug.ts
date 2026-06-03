/**
 * DEMO-ONLY (F2.5.1): kebab-case slug derivation for demo-client URLs.
 *
 * A demo client's `slug` is URL-safe and `@@unique` — it appears in admin URLs and
 * (later) invitation links, so kebab-case is the right shape ("acme-bank"), unlike
 * the question `key` slug which is snake_case. Derive-with-override: the admin may
 * type an explicit slug; when they don't, we derive one from the name and let a
 * collision surface as a 409 (we never silently mutate an admin-chosen slug).
 *
 * Pure: string-only, no Prisma / Next.
 */

/** Max slug length — keeps slugs readable and well under any column limit. */
const MAX_SLUG_LENGTH = 60;

/** Fallback when a name has no slug-able characters (e.g. only punctuation). */
const FALLBACK_SLUG = 'demo-client';

/** Combining diacritical marks, stripped after NFKD normalisation. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Derive a kebab-case ascii slug from a demo-client name: lowercase, strip
 * accents, collapse any run of non-alphanumerics to a single `-`, trim leading/
 * trailing `-`, and truncate to {@link MAX_SLUG_LENGTH}. Returns
 * {@link FALLBACK_SLUG} when nothing slug-able remains.
 */
export function slugifyDemoClient(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // re-trim if truncation left a trailing -
  return slug.length > 0 ? slug : FALLBACK_SLUG;
}

/** Validation pattern for an admin-supplied slug: kebab-case, no leading/trailing/double `-`. */
export const DEMO_CLIENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export { MAX_SLUG_LENGTH as DEMO_CLIENT_SLUG_MAX_LENGTH };
