import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';

/**
 * BrandMark — the header/footer brand slot (ConQuest override of the Sunrise
 * scaffold at `components/brand/brand-mark.tsx`).
 *
 * Sunrise ships this rendering `BRAND.name` as text; ConQuest replaces the body
 * with its styled two-tone wordmark so the public header carries the product
 * identity, matching the admin app surface and the marketing pages. The single
 * source of the lockup is {@link ConquestWordmark} — presentational only, safe
 * in the server header/footer trees.
 *
 * This is the platform's designed seam (a *render* concern an env string can't
 * express), so the override stays sync-safe: Sunrise doesn't re-edit this file
 * after shipping it. `BRAND.name` remains the identity string elsewhere (page
 * titles, footer copyright, emails) — drive it with `NEXT_PUBLIC_APP_NAME`.
 *
 * Full guide: CUSTOMIZATION.md §2.
 */
export function BrandMark(): React.ReactNode {
  return <ConquestWordmark size="page" />;
}
