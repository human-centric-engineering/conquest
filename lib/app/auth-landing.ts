/**
 * App post-authentication landing route.
 *
 * **Fork-owned scaffold** — Sunrise ships this `null` (= use the platform
 * default, `/dashboard`) and does NOT change this file after release, so your
 * edits here merge cleanly on upgrade (the stable contract is this file's
 * export, not its value).
 *
 * Set it to the route a signed-in user should land on, and every door into the
 * authenticated app follows: login, OAuth, signup, invite acceptance, email
 * verification, the header brand link, the "back to app" links out of admin, the
 * error-page escape hatches, and the proxy's redirect of a signed-in user off an
 * auth page. Sunrise hardcoded `/dashboard` at each of those sites, so an app
 * whose product lives elsewhere had to edit them all — and re-resolve them on
 * every upgrade.
 *
 * Must be a root-relative path (`/app`, not `https://…` or `//host`): it is
 * spliced into redirects and `<Link href>`, including as the fallback for
 * `safeCallbackUrl()`, whose same-origin guarantee only covers the untrusted
 * URL, not the fallback. A value that isn't root-relative throws at module load
 * rather than silently becoming an off-site redirect — see
 * `lib/auth-landing/route.ts`.
 *
 * Pair it with `lib/app/protected-nav.ts`: landing somewhere the authenticated
 * header never links to is the same dead end from the other direction. If the
 * route you set is outside `/dashboard`, `/settings` and `/profile`, also add
 * its prefix to `lib/app/protected-routes.ts` — otherwise the proxy never
 * bounces a signed-out visitor there to login, and the page has to guard itself.
 *
 * Full guide: CUSTOMIZATION.md §4 · lib/auth-landing/route.ts
 */

/** Where an authenticated user lands. `null` = platform default (`/dashboard`). */
export const appAuthLandingRoute: string | null = null;

/**
 * What that destination is called in user-visible copy — the admin "Back to …"
 * link, the error pages' escape-hatch button, the verify-email redirect notice.
 *
 * Set it alongside the route: leaving it default sends a fork's users to
 * `/programme` behind a button still labelled "Dashboard", which is the same
 * mismatch as the route itself, only quieter.
 *
 * `null` = platform default (`Dashboard`).
 */
export const appAuthLandingLabel: string | null = null;
