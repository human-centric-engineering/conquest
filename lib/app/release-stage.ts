/**
 * Release-stage seam — marks the product as pre-release (alpha / beta).
 *
 * Drives two user-facing affordances: the small stage pill on the ConQuest
 * wordmark, and the "your chats are being recorded" notice on the respondent
 * chat surface. Both light up only while the product is in `alpha` or `beta`;
 * a `stable` (or unset) stage leaves every surface unchanged.
 *
 * Reads `NEXT_PUBLIC_RELEASE_STAGE` directly from `process.env` rather than via
 * `lib/env` (which is server-only) so this module is safe to import from BOTH
 * server and client components — Next.js statically inlines the `NEXT_PUBLIC_`
 * value at build time. This mirrors the brand seam in `lib/brand.ts`.
 *
 * App-owned: the var is intentionally NOT registered in core `lib/env.ts`
 * (a platform file) so this stays a clean fork edit across upstream syncs.
 * Any value other than `alpha` / `beta` (case-insensitive) is treated as
 * `stable`, so a typo fails safe to "no badge, no notice".
 */
export type ReleaseStage = 'alpha' | 'beta' | 'stable';

const RAW = process.env.NEXT_PUBLIC_RELEASE_STAGE?.trim().toLowerCase();

/** The resolved product release stage. Unset / unrecognised ⇒ `stable`. */
export const RELEASE_STAGE: ReleaseStage = RAW === 'alpha' || RAW === 'beta' ? RAW : 'stable';

/** True while the product is pre-release (alpha or beta) — drives the badge + recording notice. */
export const IS_PRERELEASE = RELEASE_STAGE === 'alpha' || RELEASE_STAGE === 'beta';
