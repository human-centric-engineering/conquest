/**
 * AppHeader Component
 *
 * Shared header component for public and protected layouts.
 * Provides consistent branding, navigation, and user actions.
 *
 * @example
 * // Protected layout with navigation
 * <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
 *
 * @example
 * // Public layout without navigation
 * <AppHeader logoHref="/" />
 */

import Link from 'next/link';
import { HeaderActions } from '@/components/layouts/header-actions';
import { BrandMark } from '@/components/brand/brand-mark';

interface AppHeaderProps {
  /** URL for logo click (default: "/") */
  logoHref?: string;
  /** Optional caller override for the brand slot; defaults to `<BrandMark/>`. */
  logoText?: string;
  /** Desktop (md+) inline navigation, shown beside the logo. */
  navigation?: React.ReactNode;
  /** Mobile (below md) collapsed navigation (kebab menu), shown far-right with the actions. */
  mobileMenu?: React.ReactNode;
}

export function AppHeader({ logoHref = '/', logoText, navigation, mobileMenu }: AppHeaderProps) {
  return (
    <header className="border-b">
      <div className="container mx-auto flex items-center justify-between px-4 py-4">
        <div className="flex items-center gap-3 md:gap-8">
          <Link href={logoHref} className="text-xl font-bold hover:opacity-80">
            {logoText ?? <BrandMark />}
          </Link>
          {navigation}
        </div>
        <div className="flex items-center gap-2">
          <HeaderActions />
          {mobileMenu}
        </div>
      </div>
    </header>
  );
}
