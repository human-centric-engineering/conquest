/**
 * Pure assertions used by `scripts/smoke/export.ts`.
 *
 * Split out for the same reason `scripts/ci/prisma-format.ts` is split from its
 * CLI: the script self-executes on import, so anything left inside it can only
 * be exercised by running it against a real database. That is the right way to
 * verify the *queries*, and the wrong way to verify a predicate with edge cases.
 *
 * @see scripts/smoke/export.ts
 */

/**
 * Whether an app subject-data section carries nothing for this subject.
 *
 * Shape-tolerant on purpose: `AppSubjectData` is `Record<string, unknown>`, so
 * a tier may return a row list, a keyed object, or nothing at all. Asserting a
 * particular shape here would invent a contract the seam does not have, and the
 * property being checked — "this subject owns none of it" — does not need one.
 *
 * Anything else (a string, a number, a boolean) counts as **not** empty. The
 * smoke script uses this to detect a collector returning a stranger's rows, so
 * the unknown case has to fail loudly rather than be waved through.
 */
export function isEmptySection(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
