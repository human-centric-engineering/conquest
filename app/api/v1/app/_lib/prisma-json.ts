/**
 * Storage-boundary helper for Prisma JSON columns.
 *
 * Prisma distinguishes "SQL NULL" from "JSON null" on a `Json` column, so a nullish value can't
 * simply be passed through — it has to become the `Prisma.JsonNull` sentinel. Everything else is
 * handed over as opaque JSON.
 *
 * The cast is deliberately at the Prisma boundary only: callers Zod-validate on the way in, so
 * this does not (and must not) become a general-purpose escape hatch for unvalidated data.
 *
 * Lives route-side rather than under `lib/app/**` because that tree is required to stay
 * storage-agnostic (enforced by a `no-restricted-imports` rule) — anything touching `Prisma`
 * belongs with the route handlers. It sits at the `app/api/v1/app` root because both the
 * `questionnaires` and `questionnaire-sessions` route trees write JSON columns.
 */

import { Prisma } from '@prisma/client';

/** Null/undefined → SQL-NULL sentinel; anything else → opaque JSON. */
export function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value;
}

/**
 * Read a stored JSON array column back as `T[]`, defaulting a non-array (including SQL NULL) to
 * an empty array.
 *
 * **This does not validate the elements.** It checks only that the column holds an array; each
 * item is then trusted to be a `T`. That is tolerable for append-only history trails the app
 * writes itself — the shapes are ours and never user-supplied — but it means a legacy or
 * hand-edited row containing the wrong element shape will type as `T` and fail somewhere further
 * downstream instead of here. Do not reach for this on data that crosses a trust boundary; parse
 * that with Zod.
 */
export function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
