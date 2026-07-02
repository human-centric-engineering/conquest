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
 * Slugify a string for use in a filename or URL segment: lower-case, runs of non-alphanumerics
 * collapse to single hyphens, leading/trailing hyphens trimmed. Returns the bare slug (possibly
 * empty) — callers apply their own fallback (e.g. `slugify(title) || 'questionnaire'`). Pure and
 * client-safe; shared by the PDF/transcript download helpers and the completion-screen download.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
