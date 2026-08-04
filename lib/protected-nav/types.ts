/**
 * Authenticated (protected) nav — shared type + platform default.
 *
 * Platform-owned, and the mirror of `lib/public-nav/types.ts`: rendering
 * (active-state, admin filtering, responsive, a11y, the `next/link` and
 * `usePathname` glue) lives in `components/layouts/protected-nav.tsx` and keeps
 * improving upstream. This module is the *data* half — a portable item shape
 * plus the default link set.
 *
 * Sunrise reserved a seam for the marketing nav a fork's *visitors* see long
 * before it reserved one for the nav a fork's *users* see, which is how an app
 * could ship its whole product behind a header that never linked to it. The
 * seam is `lib/app/protected-nav.ts`, whose non-null export replaces this
 * default wholesale.
 */
import type { LucideIcon } from 'lucide-react';
import { LayoutDashboard, User, Settings, Shield } from 'lucide-react';

/**
 * A single authenticated nav link. Boundary-clean: string `href`/`label` plus an
 * optional `lucide-react` icon — no `next/*` types — so a fork can declare these
 * from `lib/app/protected-nav.ts` (which the `lib/app/**` boundary keeps
 * framework-agnostic).
 */
export interface ProtectedNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  /**
   * When true, the item is active only on an exact pathname match (not on child
   * routes). Defaults to prefix-matching. Lets a fork add a parent link like
   * `/projects` without it highlighting on `/projects/123`.
   */
  exact?: boolean;
  /** Render only for `role === 'ADMIN'`. Defaults to visible to everyone. */
  adminOnly?: boolean;
}

/**
 * Default authenticated nav.
 *
 * Exported so a fork that only wants to *add* a link can spread rather than
 * retype it:
 *
 *     export const protectedNavItems = [
 *       { href: '/programme', label: 'Programme', icon: Compass },
 *       ...DEFAULT_PROTECTED_NAV,
 *     ];
 *
 * Note the trade-off that spread implies: the fork pins this list as it stood at
 * upgrade time, so a link Sunrise adds later will not appear until the fork
 * re-spreads. Leaving the seam `null` is what tracks the platform default.
 */
export const DEFAULT_PROTECTED_NAV: ProtectedNavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/profile', label: 'Profile', icon: User },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/admin', label: 'Admin', icon: Shield, adminOnly: true },
];
