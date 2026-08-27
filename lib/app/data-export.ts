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
 * model in a schema file that is not one of Sunrise's own — `app.prisma`,
 * `framework-*.prisma`, or any other name you choose — must be declared as a
 * source or excluded with a reason, or the suite fails naming it.
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

import { registerAppSubjectSources } from '@/lib/privacy/subject-source-registry';
import {
  APP_SUBJECT_DATA_SOURCES,
  APP_EXCLUDED_SOURCES,
} from '@/lib/app/questionnaire/privacy/export-sources';

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
 * Declare which of ConQuest's models hold data about a person, and which
 * deliberately do not.
 *
 * Sunrise 0.10.0 (#660) turned this into a real seam. Before it, the platform
 * coverage guard scanned every `prisma/schema/*.prisma` — ours included — but
 * checked them against a manifest only core could write, so ConQuest patched
 * the platform test to skip `App*` models and ran a parallel guard of its own.
 * That fork edit is now gone: the declarations below are what the platform
 * guard reads, and `tests/unit/lib/app/privacy/export-sources.test.ts` keeps
 * this list level with `lib/app/questionnaire/privacy/export-sources.ts`.
 *
 * Sources are derived from `APP_SUBJECT_DATA_SOURCES` rather than restated, so
 * a source added there is declared here automatically and cannot drift.
 * `APP_EXCLUDED_SOURCES` carries the tables we deliberately do not export,
 * each with a reason the data subject gets to read.
 */
export function initAppSubjectSources(): void {
  registerAppSubjectSources({
    tier: 'app',
    sources: APP_SUBJECT_DATA_SOURCES.map(({ model, section, disposition, description }) => ({
      model,
      section,
      disposition,
      description,
    })),
    excluded: APP_EXCLUDED_SOURCES.map(({ model, reason }) => ({ model, reason })),
  });
}

/**
 * Collect ConQuest's data about one subject.
 *
 * Drives `APP_SUBJECT_DATA_SOURCES` — the app-tier mirror of the platform's
 * subject-data manifest.
 *
 * Nothing here is best-effort: a source that throws fails the whole export.
 * That is deliberate, and the opposite of the erasure path (where hook failures
 * are swallowed so app trouble can never block a deletion). A partial export is
 * indistinguishable from a complete one to the person reading it, so the only
 * safe failure is a loud one.
 */
export async function collectAppSubjectData(subject: AppSubjectQuery): Promise<AppSubjectData> {
  const entries = await Promise.all(
    APP_SUBJECT_DATA_SOURCES.map(
      async (source) => [source.section, await source.fetch(subject)] as const
    )
  );

  return Object.fromEntries(entries);
}
