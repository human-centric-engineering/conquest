'use client';

import Link from 'next/link';
import { useConsent } from '@/lib/consent';
import { BRAND } from '@/lib/brand';
import { resolveFooterCopyright } from '@/lib/footer/copyright';
import { footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { DEFAULT_FOOTER_NAV, DEFAULT_FOOTER_LEGAL } from '@/lib/public-nav/types';

/**
 * Public Footer Component
 *
 * Footer for public/marketing pages.
 * Includes navigation links, legal links, and the attribution line
 * (fork-overridable via `lib/app/footer.ts`).
 *
 * Phase 3.5: Landing Page & Marketing
 *
 * ConQuest sync note (Sunrise 0.11.1): this fork previously deleted the
 * attribution line outright, because it shipped as a dedicated centred row and
 * the `(public)` group also hosts the full-height respondent surfaces (`/q`,
 * `/x`, `/m`) where a second footer line is pure vertical cost. Sunrise #561
 * fixed exactly that — the line is now inline with the nav rows, not a row of
 * its own — so the local deletion was reverted and we run stock. If the
 * attribution ever needs to go, use the seam (`footerCopyright = false` in
 * `lib/app/footer.ts`) rather than editing this file; note that seam governs
 * `ProtectedFooter` too, by design.
 */

// Fork overrides (non-null arrays) replace the platform defaults wholesale.
const navigationLinks = footerNavItems ?? DEFAULT_FOOTER_NAV;
const legalLinks = footerLegalItems ?? DEFAULT_FOOTER_LEGAL;

export function PublicFooter() {
  const currentYear = new Date().getFullYear();
  const { openPreferences } = useConsent();
  const copyright = resolveFooterCopyright(currentYear, BRAND.legalName);

  return (
    <footer className="border-t">
      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          {/* Navigation Links */}
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {navigationLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Legal Links — the override governs links; the Cookie Preferences
              control below is always rendered by the platform (consent is a
              legal requirement in many jurisdictions, not fork-overridable). */}
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <button
              onClick={openPreferences}
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Cookie Preferences
            </button>
          </nav>

          {/* Attribution — last in the DOM, and last visually in both layouts
              (#561). It used to sit on a dedicated centred row below, costing
              ~44px: free on a scrolling marketing page, expensive on the
              no-login app surfaces forks host in this group. Inline also
              matches ProtectedFooter, which never had a separate row.

              Placed last rather than first with `order-last`: CSS `order`
              changes only the visual order, never the DOM or the accessibility
              tree, so ordering it visually while leaving it first in the source
              would put the reading order and the visual order in disagreement
              (WCAG 1.3.2). Source order is the honest way to say "last". */}
          {copyright && <p className="text-muted-foreground text-sm">{copyright}</p>}
        </div>
      </div>
    </footer>
  );
}
