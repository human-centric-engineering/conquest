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
 * .context/app/questionnaire/forking.md § "Replacing demo tenancy". The theme fields
 * (F3.4) are DEMO-ONLY branding — a fork that drops demo tenancy drops them too.
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
  // DEMO-ONLY (F3.4): brand theme — null on any field means "use the Sunrise default"
  // (resolveTheme fills it). The invitation email renders all four; accentColor is the
  // email's fallback-link colour and doubles as the F7.1 CSS-variable accent.
  /** CTA / primary button colour (hex), or null for the Sunrise default. */
  ctaColor: string | null;
  /** Accent colour (hex) — email fallback-link colour + F7.1 accent; null = default. */
  accentColor: string | null;
  /** Absolute https logo URL shown in the invitation email, or null. */
  logoUrl: string | null;
  /** Branded invitation intro line, or null for the Sunrise default copy. */
  welcomeCopy: string | null;
  /** How many questionnaires are attributed to this client (drives the delete guard). */
  questionnaireCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Detail is the same shape as a list row — kept as a distinct alias so a later phase
 * can widen detail (e.g. the attributed-questionnaire list) without touching the list
 * contract. (F3.4 added the theme fields to the shared view: the edit form prefills
 * them and the small demo-clients list tolerates the extra columns.)
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
