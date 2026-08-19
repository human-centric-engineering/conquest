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
 * **Keep it complete — and core now checks that you did.** Declare your tables
 * in `initAppSubjectSources()` below. The core guard test
 * (`export-sources.test.ts`) diffs `prisma/schema/*.prisma` against the core
 * manifest so a new core table can't quietly narrow the export, and it holds
 * your tier's schema file to the same rule against your declarations: **every**
 * model in `app.prisma` / `framework-*.prisma` must be declared as a source or
 * excluded with a reason, or the suite fails naming it.
 *
 * Full accounting, rather than the user-id heuristic core applies to itself,
 * because core reads its own column vocabulary and cannot read yours: a table
 * keyed `authorId` or `respondentId` is invisible to that scan, and the tables
 * it cannot see are exactly the ones nobody remembers. A lookup or join table
 * holding no personal data is an `excluded` row with a one-line reason — which
 * is the note a DPO wants anyway, and it costs you a line once per table.
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
 * Declare which of your tier's models hold data about a person, and which
 * deliberately do not.
 *
 * **Fork-owned scaffold**, run once and lazily by
 * `lib/privacy/subject-source-registry.ts` before its first read — so the
 * coverage guard and the export both see your declarations with no wiring step.
 *
 * ```ts
 * export function initAppSubjectSources(): void {
 *   registerAppSubjectSources({
 *     tier: 'app',
 *     sources: [
 *       {
 *         model: 'AppInvoice',
 *         section: 'invoices',
 *         disposition: 'export',
 *         description: 'Invoices raised against your account.',
 *       },
 *     ],
 *     excluded: [
 *       { model: 'AppCountry', reason: 'Reference list of countries — holds no personal data.' },
 *     ],
 *   });
 * }
 * ```
 *
 * A framework tier declares from its own init with `tier: 'framework'`; both
 * tiers register independently, so filling this in does not consume the slot a
 * leaf fork is entitled to.
 *
 * **Every `section` you declare must appear in what `collectAppSubjectData()`
 * returns** — `exportUserData()` throws if one is missing. Return the key with
 * an empty array when the subject has no rows rather than omitting it: a bundle
 * short by a section reads exactly like a complete answer. `undefined` counts
 * as missing, because `JSON.stringify` drops the key — so
 * `rows.length ? rows : undefined` is the shape to avoid.
 */
export function initAppSubjectSources(): void {
  // No app subject sources by default.
}

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
