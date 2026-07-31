/**
 * App subject-data export seam (GDPR Art. 15).
 *
 * **Fork-owned scaffold** — Sunrise ships this returning nothing and does NOT
 * change it after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's `collectAppSubjectData` export, not its body).
 * Treat it like the other `lib/app/*` seams.
 *
 * Auto-wired: `exportUserData()` (`lib/privacy/export-user.ts`) calls this and
 * folds the result into the `app` section of the export bundle, so both the
 * self-service and admin export endpoints pick it up with no core edit.
 *
 * Declare every app-owned table that holds data about a person. Core covers its
 * own tables via `lib/privacy/export-sources.ts`; it cannot see yours.
 *
 * ```ts
 * export async function collectAppSubjectData({ userId }: AppSubjectQuery): Promise<AppSubjectData> {
 *   const [invoices, bookings] = await Promise.all([
 *     prisma.appInvoice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
 *     prisma.appBooking.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
 *   ]);
 *   return { invoices, bookings };
 * }
 * ```
 *
 * **Why a plain function and not a registry.** The erasure sibling
 * (`lib/privacy/erasure-hooks.ts`) is a boot-time registry, and this seam
 * deliberately is not. Erasure fails loudly if a hook never registers — the
 * rows are still there afterwards. An export fails *silently*: an unregistered
 * collector yields a bundle that looks complete and is not, and neither the
 * subject nor the operator can tell. A static import cannot be missed.
 *
 * **Keep it complete.** The core guard test (`export-sources.test.ts`) diffs
 * `prisma/schema/*.prisma` against the core manifest so a new core table can't
 * quietly narrow the export. Your tables need the same protection, and core
 * cannot write it for you — the pattern worth copying is a constant listing the
 * tables you export plus a test that greps your own schema file for
 * `@@map("app_…")` and asserts each mapped table appears in it. Then adding a
 * table without extending the export fails your build instead of shipping a
 * short answer to a data subject.
 *
 * A table holding no personal data (lookup tables, org config with no person in
 * it) is fine to leave out — but say so in a comment where you list them, so
 * the omission reads as a decision rather than an oversight.
 *
 * Full guide: .context/privacy/data-export.md · CUSTOMIZATION.md §4
 */

/** Identity of the subject being exported. */
export interface AppSubjectQuery {
  /** Id of the data subject. */
  userId: string;
  /** The subject's email — for app tables keyed by address rather than user id. */
  email: string;
}

/**
 * App-owned subject data, keyed by section name. Each section lands under
 * `app.<section>` in the export bundle. Values must be JSON-serialisable.
 */
export type AppSubjectData = Record<string, unknown>;

/**
 * Collect this app's data about one subject. Ships empty — vanilla Sunrise has
 * no app tables, so the export's `app` section is `{}`.
 */
/*
 * `async` is the seam's contract, not an implementation detail: every real
 * collector awaits its queries, and the empty default must not force forks to
 * change the signature just to add one.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function collectAppSubjectData(_subject: AppSubjectQuery): Promise<AppSubjectData> {
  return {};
}
