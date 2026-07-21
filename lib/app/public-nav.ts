/**
 * App public marketing nav overrides.
 *
 * **Fork-owned scaffold** — Sunrise ships every list `null` (= use the platform
 * default) and does NOT change this file after release, so your edits here merge
 * cleanly on upgrade (the stable contract is this file's exports, not their
 * values). Treat it like the landing page: a starting point you're expected to
 * modify.
 *
 * Forks OWN these lists, so the model is *replacement*, not append: set a list
 * to a non-null `PublicNavItem[]` and it **replaces** the platform default
 * wholesale (remove/rename/reorder freely). Leave it `null` to keep the default.
 *
 * Auto-wired: `components/layouts/public-nav.tsx` reads `publicNavItems`;
 * `public-footer.tsx` reads `footerNavItems` and `footerLegalItems`. The
 * `next/link` / active-state glue stays in those platform components.
 *
 * Not overridable: the footer's **Cookie Preferences** control is always
 * rendered by the platform regardless of `footerLegalItems` — this seam governs
 * *links*, not the consent control (a legal requirement in many jurisdictions).
 *
 * Boundary-clean: the `PublicNavItem` type is type-only; the `lucide-react`
 * icon imports below are runtime values but permitted under the `lib/app/**`
 * boundary (it bans `next/*` runtime, not icon libs — same as `admin-nav.ts`).
 *
 * Full guide: CUSTOMIZATION.md §4 · lib/public-nav/types.ts
 */
import { Home, Layers, Mail, Tag } from 'lucide-react';

import type { PublicNavItem } from '@/lib/public-nav/types';

/**
 * Header nav. Replaces the Sunrise default wholesale with the ConQuest marketing
 * set — Home / Capabilities / Pricing / Contact (the ConQuest pitch is the
 * homepage, and Sunrise's default "About" is dropped). `/` is exact; the rest
 * prefix-match.
 */
export const publicNavItems: PublicNavItem[] | null = [
  { href: '/', label: 'Home', icon: Home, exact: true },
  { href: '/capabilities', label: 'Capabilities', icon: Layers },
  { href: '/pricing', label: 'Pricing', icon: Tag },
  { href: '/contact', label: 'Contact', icon: Mail },
];

/**
 * Footer link cluster. Mirrors the header (the footer ignores `icon`, so these
 * are link-only).
 */
export const footerNavItems: PublicNavItem[] | null = [
  { href: '/', label: 'Home' },
  { href: '/capabilities', label: 'Capabilities' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/contact', label: 'Contact' },
];

/**
 * Footer legal cluster. ConQuest's Privacy / Terms match the platform default,
 * so leave it `null` to inherit. The Cookie Preferences control renders
 * regardless of this list.
 */
export const footerLegalItems: PublicNavItem[] | null = null;
