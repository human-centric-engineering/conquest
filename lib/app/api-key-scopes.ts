/**
 * App API-key scopes.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its value). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `lib/auth/api-keys.ts` unions these with the core scopes, and
 * `createApiKeySchema` validates against the same union — so a name listed here
 * becomes mintable through `POST /api/v1/user/api-keys` and checkable with
 * `hasScope()`. A *data* seam rather than a registrar, because the value is
 * data: that also lets the Zod schema read it without dragging a server module
 * into the client bundle it is imported from.
 *
 * ## Why this is hardening, not convenience
 *
 * `withAuth` accepts an API key of **any** scope. Combine that with a closed
 * scope list and least privilege is unavailable to a fork: the only key a user
 * can mint for one narrow purpose is one that also reaches every other
 * authenticated route as them. A key that lives on a phone, in a share sheet,
 * invoked by a Back Tap, is exactly the key that should be narrow (#542).
 *
 * A scope only means something if a route **enforces** it, so pair this with
 * the `scope` option on `withAuth`:
 *
 * @example
 * ```ts
 * // lib/app/api-key-scopes.ts — yours to edit (ships empty)
 * export const APP_API_KEY_SCOPES: readonly string[] = ['capture'];
 *
 * // app/api/v1/app/capture/route.ts
 * export const POST = withAuth(handler, { scope: 'capture' });
 * ```
 *
 * Names are lower snake_case, must not collide with a core scope
 * (`chat`, `analytics`, `knowledge`, `webhook`, `admin`), and a malformed or
 * colliding entry is dropped with a logged error rather than widening what can
 * be minted. `admin` still satisfies every scope check and still requires an
 * ADMIN user to mint.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/api-keys.md
 */

/** Extra scope names this app can mint and enforce. Empty = core scopes only. */
export const APP_API_KEY_SCOPES: readonly string[] = [];
