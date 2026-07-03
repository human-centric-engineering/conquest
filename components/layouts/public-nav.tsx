'use client';

/**
 * Public Navigation Component
 *
 * Navigation links for public pages. Highlights the current page.
 * Rendered in two slots the header places independently: `PublicNav` (inline,
 * desktop) beside the brand, and `PublicNavMenu` (kebab, mobile) far-right with
 * the header actions. Both share the same resolved items via `usePublicNavItems`.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { usePathname } from 'next/navigation';
import { HeaderNavLinks, HeaderNavMenu, type HeaderNavItem } from '@/components/layouts/header-nav';
import { publicNavItems } from '@/lib/app/public-nav';
import { DEFAULT_PUBLIC_NAV } from '@/lib/public-nav/types';

// Fork override (a non-null array) replaces the platform default wholesale.
const navItems = publicNavItems ?? DEFAULT_PUBLIC_NAV;

function usePublicNavItems(): HeaderNavItem[] {
  const pathname = usePathname();

  return navItems.map((item) => {
    // Exact items (and the root `/`, which every path is a prefix of) match
    // only on equality; everything else prefix-matches so `/about/team`
    // highlights "About". A fork sets `exact` to keep a parent link like
    // `/docs` from highlighting on `/docs/intro`.
    const isActive =
      item.exact || item.href === '/'
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`);

    return { href: item.href, label: item.label, icon: item.icon, isActive };
  });
}

export function PublicNav() {
  return <HeaderNavLinks items={usePublicNavItems()} />;
}

export function PublicNavMenu() {
  return <HeaderNavMenu items={usePublicNavItems()} />;
}
