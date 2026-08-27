/**
 * App account-section registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `getRegisteredAccountSections()` calls this once before the first
 * read, so it is populated whichever of `/profile` or `/settings` renders
 * first.
 *
 * Your section renders at the **foot of the page**, below the profile cards or
 * below the settings tabs. It is deliberately not a fifth tab: the tab list is
 * a fixed four-column grid and a fork's section is not always tab-shaped. If
 * you want the account surface in your own shell entirely, take a route group
 * instead — see CUSTOMIZATION.md, "When a surface needs a different frame".
 *
 * @example
 * ```ts
 * import { registerAccountSection } from '@/lib/account-sections/registry';
 * import { GitHubConnectSection } from '@/components/app/account/github-connect';
 *
 * export function initAppAccountSections(): void {
 *   registerAccountSection({
 *     id: 'github-connect',
 *     surfaces: ['profile', 'settings'], // the default; narrow it if you need to
 *     order: 10,
 *     Component: GitHubConnectSection,   // receives { userId }
 *   });
 * }
 * ```
 *
 * Your component lives in `components/app/**` (the reserved leaf tier), not
 * here — `lib/app/**` must stay framework-agnostic, so this file holds the
 * registration and the import, never the JSX.
 *
 * Full guide: CUSTOMIZATION.md §4 · lib/account-sections/registry.ts
 */
export function initAppAccountSections(): void {
  // No app account sections by default.
}
