'use client';

/**
 * Shared sub-navigation strip for admin **workspace** surfaces (questionnaire
 * workspace, demo-client detail). Renders one of two shapes from the same props:
 *
 * - **Flat** (a single group) — one row of underline tabs, identical to the
 *   original single-tier bar. Used by surfaces with a handful of tabs that don't
 *   warrant grouping (demo clients).
 * - **Two-tier** (multiple groups) — a top row of lifecycle groups, and, when the
 *   active group has more than one tab, a second row of its child tabs. Collapses
 *   a long flat strip (the questionnaire workspace had 13) into ~5 primary
 *   destinations so nothing scrolls off-screen.
 *
 * Purely presentational: callers pre-compute every `href` (this component is
 * framework-route-agnostic beyond `usePathname` for active-state) and decide
 * which groups are `dimmed`. Active-state detection mirrors the admin sidebar —
 * exact match for a tab flagged `exact` (so an Overview/index tab isn't lit on
 * every sub-route), prefix match otherwise.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export interface SubNavTab {
  /** Stable id (also the React key). */
  id: string;
  /** Visible label. */
  label: string;
  /** Absolute href, pre-computed by the caller. */
  href: string;
  /** Match exactly (not by prefix) so an index tab isn't active on every sub-route. */
  exact?: boolean;
}

export interface SubNavGroup {
  /** Stable id (also the React key). */
  id: string;
  /** Visible label in the top tier. */
  label: string;
  /** Where the top-tier group link goes — conventionally its first child's href. */
  href: string;
  /** Visually de-emphasize the group (still clickable). */
  dimmed?: boolean;
  /** Tooltip explaining why a dimmed group is dimmed. */
  dimmedHint?: string;
  /** The group's child tabs, in display order. */
  tabs: readonly SubNavTab[];
}

interface GroupedSubNavProps {
  groups: readonly SubNavGroup[];
  /** Accessible label for the top-tier <nav>. */
  ariaLabel: string;
}

function isTabActive(href: string, pathname: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** A single row of underline tabs — the flat shape and the two-tier top row share it. */
function TopTierLink({
  href,
  label,
  active,
  dimmed,
  title,
  ariaCurrent,
}: {
  href: string;
  label: string;
  active: boolean;
  dimmed?: boolean;
  title?: string;
  ariaCurrent?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={ariaCurrent ? 'page' : undefined}
      title={dimmed && !active ? title : undefined}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
        active
          ? 'text-foreground border-[color:var(--cq-accent)] font-medium'
          : 'text-muted-foreground hover:text-foreground border-transparent',
        dimmed && !active && 'opacity-50'
      )}
    >
      {label}
    </Link>
  );
}

export function GroupedSubNav({ groups, ariaLabel }: GroupedSubNavProps) {
  const pathname = usePathname();

  // Nothing to render (e.g. every group filtered away) — emit nothing, not an empty bar.
  if (groups.length === 0) return null;

  // Flat shape: a single group renders its tabs as one underline row — visually
  // identical to the original single-tier bar, no redundant top tier.
  if (groups.length === 1) {
    const only = groups[0];
    return (
      <nav aria-label={ariaLabel} className="flex items-center gap-1 overflow-x-auto border-b">
        {only.tabs.map((tab) => {
          const active = isTabActive(tab.href, pathname, tab.exact);
          return (
            <TopTierLink
              key={tab.id}
              href={tab.href}
              label={tab.label}
              active={active}
              ariaCurrent={active}
            />
          );
        })}
      </nav>
    );
  }

  // Two-tier shape: the active group is whichever one owns the active tab.
  const activeGroup =
    groups.find((group) => group.tabs.some((tab) => isTabActive(tab.href, pathname, tab.exact))) ??
    null;
  // Second tier only when the active group has children worth showing.
  const childTabs = activeGroup && activeGroup.tabs.length > 1 ? activeGroup.tabs : null;

  return (
    <div>
      <nav aria-label={ariaLabel} className="flex items-center gap-1 overflow-x-auto border-b">
        {groups.map((group) => {
          const active = group.id === activeGroup?.id;
          return (
            <TopTierLink
              key={group.id}
              href={group.href}
              label={group.label}
              active={active}
              ariaCurrent={active}
              dimmed={group.dimmed}
              title={group.dimmedHint}
            />
          );
        })}
      </nav>

      {childTabs && (
        <nav
          aria-label={`${activeGroup!.label} sections`}
          className="flex items-center gap-1 overflow-x-auto pt-2 pb-1"
        >
          {childTabs.map((tab) => {
            const active = isTabActive(tab.href, pathname, tab.exact);
            return (
              <Link
                key={tab.id}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs whitespace-nowrap transition-colors',
                  active
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
