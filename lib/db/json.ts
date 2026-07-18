/**
 * Storage-agnostic sentinels for writing nullable `Json` columns.
 *
 * Prisma distinguishes two kinds of "null" for a `Json?` column — SQL `NULL` and the JSON literal
 * `null` — and refuses a plain JS `null`, so clearing one requires the `Prisma.DbNull` sentinel.
 * Importing `@prisma/client` to get it is not an option everywhere: `lib/app/**` is the fork-extension
 * surface and ESLint deliberately bans runtime Prisma imports there (see the app-extension boundary in
 * `eslint.config.mjs`), so that code stays portable.
 *
 * Re-exporting the sentinel from `lib/` keeps that boundary intact: app code can clear a Json column
 * without taking on a Prisma dependency, and if the storage layer is ever swapped this is the one
 * place that changes.
 */

import { Prisma } from '@prisma/client';

/**
 * Sets a nullable `Json` column to SQL `NULL` (a genuinely absent value) — as opposed to
 * {@link DB_JSON_LITERAL_NULL}, which stores the JSON value `null`.
 */
export const DB_JSON_NULL = Prisma.DbNull;

/** Stores the JSON literal `null` as the column's value. Rarely what you want; prefer {@link DB_JSON_NULL}. */
export const DB_JSON_LITERAL_NULL = Prisma.JsonNull;
