'use client';

import Link from 'next/link';
import { useConsent } from '@/lib/consent';
import { footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { DEFAULT_FOOTER_NAV, DEFAULT_FOOTER_LEGAL } from '@/lib/public-nav/types';

/**
 * Public Footer Component
 *
 * Footer for public/marketing pages.
 * Includes navigation links and legal links.
 *
 * Phase 3.5: Landing Page & Marketing
 *
 * ConQuest-local platform edit: the centred "© <year> <legalName>. All rights reserved."
 * row was removed. The `(public)` group also hosts the full-height respondent conversation
 * surfaces (`/q`, `/x`, `/m`), where a second footer line is pure vertical cost. Attribution
 * to `BRAND.legalName` still ships on the authenticated surface via `ProtectedFooter`.
 * Re-apply this deletion if an upstream Sunrise sync restores the row.
 */

// Fork overrides (non-null arrays) replace the platform defaults wholesale.
const navigationLinks = footerNavItems ?? DEFAULT_FOOTER_NAV;
const legalLinks = footerLegalItems ?? DEFAULT_FOOTER_LEGAL;

export function PublicFooter() {
  const { openPreferences } = useConsent();

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
        </div>
      </div>
    </footer>
  );
}
