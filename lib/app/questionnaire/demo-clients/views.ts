/**
 * DEMO-ONLY (F2.5.1): client-safe view contracts for the demo-client admin surface.
 *
 * The shapes the demo-client GET endpoints return and the admin UI consumes —
 * pure types, no Prisma / Next / server-only imports, so both the route
 * serializers and the `'use client'` table/form components import one contract.
 * Dates are ISO strings (they cross the HTTP boundary). Distinct from the
 * `AppDemoClient` Prisma row: these are the trimmed, enriched projections the UI
 * needs (e.g. the attributed-questionnaire count).
 *
 * FORK-GUIDANCE: a real client engagement strips demo tenancy — see
 * .context/app/questionnaire/forking.md § "Replacing demo tenancy". Theme fields
 * are deliberately absent here (they land with their first renderer, F3.4 / F7.1).
 */

/** One row in the admin demo-clients list (and the full detail — same shape today). */
export interface DemoClientView {
  id: string;
  /** URL-safe identifier ("acme-bank"). */
  slug: string;
  /** Display name ("Acme Bank Demo"). */
  name: string;
  /** Internal admin note, or null. */
  description: string | null;
  /** Soft-disable flag — an inactive client is excluded from the attribution picker. */
  isActive: boolean;
  /** How many questionnaires are attributed to this client (drives the delete guard). */
  questionnaireCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Detail is the same shape as a list row at F2.5.1 — kept as a distinct alias so
 * later phases can widen detail (theme fields, attributed-questionnaire list)
 * without touching the list contract.
 */
export type DemoClientDetail = DemoClientView;

/**
 * Compact attribution summary embedded in a questionnaire list/detail row — what
 * the questionnaire surface shows for "this is the Acme Bank demo". `null` when the
 * questionnaire is a generic Sunrise demo (`demoClientId` unset).
 */
export interface AttributedDemoClient {
  id: string;
  slug: string;
  name: string;
}
