'use client';

/**
 * Protected Navigation Component
 *
 * Navigation links for protected routes. Highlights the current page and shows
 * the admin link only to admin users. Rendered in two slots the header places
 * independently: `ProtectedNav` (inline, desktop) beside the brand, and
 * `ProtectedNavMenu` (kebab, mobile) far-right with the header actions. Both
 * share the same resolved items via `useProtectedNavItems`.
 *
 * Phase 3.2: User Management
 * Phase 4.4: Admin Dashboard link
 */

import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/auth/client';
import { LayoutDashboard, User, Settings, Shield } from 'lucide-react';
import { HeaderNavLinks, HeaderNavMenu, type HeaderNavItem } from '@/components/layouts/header-nav';

const navItems = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    adminOnly: false,
  },
  {
    href: '/profile',
    label: 'Profile',
    icon: User,
    adminOnly: false,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    adminOnly: false,
  },
  {
    href: '/admin',
    label: 'Admin',
    icon: Shield,
    adminOnly: true,
  },
];

function useProtectedNavItems(): HeaderNavItem[] {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';

  return navItems
    .filter((item) => !item.adminOnly || isAdmin)
    .map((item) => ({
      href: item.href,
      label: item.label,
      icon: item.icon,
      isActive: pathname === item.href || pathname.startsWith(`${item.href}/`),
    }));
}

export function ProtectedNav() {
  return <HeaderNavLinks items={useProtectedNavItems()} />;
}

export function ProtectedNavMenu() {
  return <HeaderNavMenu items={useProtectedNavItems()} />;
}
