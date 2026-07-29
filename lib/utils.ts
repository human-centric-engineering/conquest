import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility function to merge Tailwind CSS classes
 * Used by shadcn/ui components
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Type guard for plain record objects.
 *
 * Returns `true` when `value` is a non-null, non-array object, narrowing it
 * to `Record<string, unknown>`. Use this instead of `as Record<…>` casts
 * whenever you need to safely inspect properties on an unknown value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Slugify a string for use in a filename or URL segment: lower-case, runs of
 * non-alphanumerics collapse to single hyphens, leading/trailing hyphens
 * trimmed.
 *
 * Returns the BARE slug, including the empty string — an all-punctuation or
 * all-CJK input legitimately slugifies to `''`, and the right fallback is
 * caller-specific (`'report'`, `'questionnaire'`, a record id). Swallowing that
 * inside the helper leads to surprising filenames, so callers apply their own:
 *
 *     const filename = `${slugify(title) || 'report'}.pdf`;
 *
 * Pure and client-safe (no Node imports), so the same helper works in a
 * download button and in a server-side PDF/transcript filename — which is the
 * main reason to share it at all.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
