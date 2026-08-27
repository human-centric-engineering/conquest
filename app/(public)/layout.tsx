import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav, PublicNavMenu } from '@/components/layouts/public-nav';
import { PublicFooter } from '@/components/layouts/public-footer';
import { MaintenanceWrapper } from '@/components/maintenance-wrapper';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: {
    template: `%s - ${BRAND.name}`,
    default: BRAND.name,
  },
  // Was the starter blurb, hardcoded — which every fork shipped as the meta
  // description across its whole marketing surface. The root layout's
  // `BRAND.description` does NOT reach here: Next resolves metadata at the
  // nearest segment that defines a field, so a group declaring `description`
  // overrides the root outright. That is why #519's root-only fix was not
  // enough on its own.
  description: BRAND.description,
};

/**
 * Public Layout
 *
 * Layout for public pages (landing, about, contact, etc.)
 * Includes shared header with branding, navigation, and user actions.
 *
 * Phase 3.5: Landing Page & Marketing
 * Phase 4.4: Added maintenance mode support
 */
export default function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <MaintenanceWrapper>
      <div className="bg-background flex min-h-screen flex-col">
        <AppHeader logoHref="/" navigation={<PublicNav />} mobileMenu={<PublicNavMenu />} />
        <main className="flex-1">{children}</main>
        <PublicFooter />
      </div>
    </MaintenanceWrapper>
  );
}
