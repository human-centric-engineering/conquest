/**
 * DEMO-ONLY: the one list of theme columns to select.
 *
 * Every consumer of a demo client's brand — the invitation email, the respondent surface,
 * the report notification, four export PDFs, the admin list — loads it with its own
 * hand-written Prisma `select`. Nine of them, each enumerating the columns by name, and
 * nothing connected them: adding a column meant finding all nine, and missing one produced
 * no error at all, because `resolveTheme()` treats an absent key exactly like an explicit
 * null. The surface simply renders unbranded, which is a plausible enough result that
 * nobody notices.
 *
 * That is not hypothetical. Four of those selects still listed only the original four
 * columns from F3.4, so `transcript-pdf-document.tsx` — which reads `surfaceColor` — has
 * been rendering transcripts without the client's band since F7.1 shipped, silently.
 *
 * So: ONE fragment. A plain object literal of `true`s, not a Prisma type (this module stays
 * Prisma-free — see theme.ts), spread into whatever `select` the caller is building. Add a
 * theme column here and the whole product picks it up.
 *
 * The keys are deliberately the WHOLE set rather than a per-consumer subset. Six extra
 * nullable text columns cost nothing on a query that is already fetching a row, and the
 * alternative — "the email needs these five, the PDF those seven" — is how the drift
 * started. Consumers that don't render a given field simply ignore it.
 */

import type { DemoClientTheme } from '@/lib/app/questionnaire/theming/theme';

/**
 * Every column `resolveTheme()` reads, as a Prisma `select` fragment.
 *
 * Usage: `select: { ...DEMO_CLIENT_THEME_SELECT }`, or spread into a larger selection
 * alongside identity columns.
 */
export const DEMO_CLIENT_THEME_SELECT = {
  // F3.4 — the original four (invitation email).
  ctaColor: true,
  accentColor: true,
  logoUrl: true,
  welcomeCopy: true,
  // F7.2 — the full-bleed header banner (respondent surface only, but selected everywhere
  // so the fragment stays one thing; renderers that have no band ignore it).
  bannerUrl: true,
  // F7.1+ — chrome around the conversation.
  surfaceColor: true,
  ctaColorEnd: true,
  logoBackgroundColor: true,
  logoBackgroundEnabled: true,
  // Brand kit — the ground the conversation is drawn on, the type it is set in, the marks.
  canvasColor: true,
  inkColor: true,
  canvasColorDark: true,
  inkColorDark: true,
  accentColorEnd: true,
  logoMarkUrl: true,
  logoDarkUrl: true,
  fontPairing: true,
} as const;

/**
 * The guard that makes the paragraph above true rather than aspirational: a compile-time
 * assertion that the fragment selects EVERY field the resolver's own contract declares.
 *
 * `DemoClientTheme` is the shape `resolveTheme()` reads, so a new field there without a
 * matching key here is now a type error — where before it was a column silently absent from
 * nine queries and a surface that quietly rendered unbranded. `satisfies` rather than a type
 * annotation so the const keeps its literal type for Prisma's inference.
 */
const _selectsEveryThemeField = DEMO_CLIENT_THEME_SELECT satisfies Record<
  keyof Required<DemoClientTheme>,
  true
>;
void _selectsEveryThemeField;
