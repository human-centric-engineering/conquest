/**
 * App brand identity.
 *
 * **Fork-owned scaffold** — Sunrise ships `null` (= "Sunrise") and does not
 * change this file after release, so your edits merge cleanly on upgrade.
 *
 * Read by `lib/brand.ts`, which every brand-bearing surface already imports:
 * layout metadata, the header `<BrandMark>`, both footers, the email templates.
 * Setting a value here is the whole change.
 *
 * Why code rather than `NEXT_PUBLIC_*`: those are inlined at **build time** and
 * no container build delivered them, so a fork with its brand correctly
 * configured still shipped as "Sunrise" (#661). Brand identity is also a
 * constant of the fork — the same in every environment, not a secret, and
 * better off visible in review.
 *
 * Full guide: CUSTOMIZATION.md §2
 */

/** Product name — page titles, header/footer brand, emails. `null` → "Sunrise". */
// FORK FILL (ConQuest). Moved here from `NEXT_PUBLIC_APP_NAME` on the Sunrise
// 0.11.0 sync — #661 removed that variable because `NEXT_PUBLIC_*` is inlined at
// build time and `.dockerignore` excludes `.env*`, so on a container build it
// delivered nothing and the footer read "© <year> Sunrise" regardless.
export const appBrandName: string | null = 'ConQuest';

/**
 * Copyright holder, where it differs from the product (e.g. product "ConQuest"
 * © "All Too Human Ltd"). `null` → the product name.
 */
// FORK FILL (ConQuest) — was `NEXT_PUBLIC_LEGAL_NAME`. The operating company,
// distinct from the product name: this is what both footers attribute to.
export const appBrandLegalName: string | null = 'All Too Human Ltd';

/**
 * Root `<meta name="description">`, for any page that sets none of its own.
 * `null` → the product name — deliberately not a sentence, because a wrong
 * sentence is worse than a short one (#519).
 */
// FORK FILL (ConQuest). Reaches fewer surfaces than it looks — every shipped
// page declares its own `description`, so this is what `app/not-found.tsx` and
// the root `error.tsx` / `global-error.tsx` serve: the 404 and error pages,
// which are precisely the ones nobody thinks to check.
export const appBrandDescription: string | null =
  'Answer a questionnaire in conversation, not in form fields.';
