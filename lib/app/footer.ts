/**
 * App footer overrides.
 *
 * **Fork-owned scaffold** — Sunrise ships `null` (= use the platform default)
 * and does NOT change this file after release, so your edits here merge cleanly
 * on upgrade (the stable contract is this file's exports, not their values).
 *
 * Auto-wired: read by **both** `components/layouts/public-footer.tsx` and
 * `components/layouts/protected-footer.tsx`, so the two cannot drift apart on
 * what the attribution line says.
 *
 * Sibling seams: footer *links* live in `lib/app/public-nav.ts`
 * (`footerNavItems`, `footerLegalItems`). This file governs the attribution
 * line only.
 *
 * **Not overridable, deliberately:** the footer's **Cookie Preferences** control
 * renders regardless of anything here — consent is a legal requirement in many
 * jurisdictions, not a branding choice. A fork that supplies its own footer
 * frame instead of the platform's has to render a real one of its own; see
 * CUSTOMIZATION.md §4.
 *
 * Boundary-clean: no imports at all, so this stays within the `lib/app/**`
 * framework-agnostic boundary.
 *
 * Full guide: CUSTOMIZATION.md §4
 */

/**
 * The attribution line under the footer links.
 *
 * - `null` — platform default: `© {year} {BRAND.legalName}`.
 * - a string — replaces the line verbatim. No year is interpolated; supply
 *   your own if you want one, or omit it (a copyright notice is not a
 *   precondition of copyright under Berne, and a stale year is worse than none).
 * - `false` — renders nothing.
 *
 * `false` is the white-label case: a fork whose public surface is an end-user
 * artefact rather than a marketing site — a questionnaire a respondent sits in,
 * an embedded widget — where naming the platform operator at the foot of the
 * page is a leak rather than a credit.
 */
export const footerCopyright: string | false | null = null;
