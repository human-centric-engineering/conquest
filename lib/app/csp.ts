/**
 * App Content-Security-Policy additions.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's exports, not their values).
 *
 * Auto-wired: `lib/security/headers.ts` folds these into the global CSP that
 * `proxy.ts` sets on every response, so you never edit the platform's directive
 * table.
 *
 * Only exact `https://` origins are accepted — `https://player.vimeo.com`,
 * `https://*.example.com`. Anything else (a bare `*`, a `data:` scheme, a
 * value with whitespace or `;`) is dropped with a warning rather than widening
 * the policy, because this list is spliced into a header.
 *
 * **Keep the list exactly as broad as the feature.** The safety argument that
 * makes an allowlist acceptable is that your code only ever builds iframe
 * `src`s on these hosts, from a *validated* id — never from an admin's raw
 * input. A hostile stored value should resolve to `null` (no iframe) in your
 * resolver, upstream of the CSP ever mattering. Prefer the privacy-preserving
 * host where one exists (`youtube-nocookie.com` over `youtube.com`).
 *
 * @example
 * ```ts
 * export const appFrameSrc: string[] = [
 *   'https://www.youtube-nocookie.com',
 *   'https://player.vimeo.com',
 * ];
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/security/overview.md
 */

/** Extra `frame-src` origins. Empty = platform default (`'self'` only). */
export const appFrameSrc: string[] = [];
