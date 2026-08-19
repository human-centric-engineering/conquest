/**
 * Resolve the footer attribution line from the fork seam.
 *
 * Platform-owned. Both footers call this so they cannot disagree about what the
 * line says — before #561 they already did: `PublicFooter` rendered
 * "© {year} {legalName}. All rights reserved." on a dedicated centred row while
 * `ProtectedFooter` rendered "© {year} {legalName}" inline, so the marketing
 * footer was taller than the authenticated one while saying strictly less.
 *
 * @see lib/app/footer.ts — the fork-owned override
 */

import { footerCopyright } from '@/lib/app/footer';

/**
 * @param year   Render-time year. Passed in rather than read here so the caller
 *               controls it — a page cached over New Year should not claim a
 *               copyright that has expired.
 * @param legalName `BRAND.legalName` — the entity, not the product.
 * @returns The line to render, or `null` to render nothing.
 */
export function resolveFooterCopyright(year: number, legalName: string): string | null {
  if (footerCopyright === false) return null;
  if (typeof footerCopyright === 'string') return footerCopyright;
  return `© ${year} ${legalName}`;
}
