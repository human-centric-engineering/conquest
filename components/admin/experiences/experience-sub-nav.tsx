'use client';

/**
 * Experience workspace sub-navigation.
 *
 * Builds hrefs from `EXPERIENCE_WORKSPACE_TABS` and applies active-state detection. Client-side
 * only for `usePathname` — the tab list itself is plain data resolved on the server.
 *
 * The Overview tab matches exactly; every other tab matches on prefix so its own sub-routes keep
 * it lit.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';
import {
  experienceTabHref,
  type ExperienceWorkspaceTab,
} from '@/lib/app/questionnaire/experiences/workspace-nav';

export function ExperienceSubNav({
  experienceId,
  tabs,
}: {
  experienceId: string;
  tabs: readonly ExperienceWorkspaceTab[];
}) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 overflow-x-auto border-b" aria-label="Experience">
      {tabs.map((tab) => {
        const href = experienceTabHref(experienceId, tab);
        const isActive = tab.exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={tab.id}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative -mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              isActive
                ? 'text-foreground border-[color:var(--cq-accent)] font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
