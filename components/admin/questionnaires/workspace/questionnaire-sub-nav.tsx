'use client';

/**
 * Horizontal tab bar for the questionnaire workspace.
 *
 * Receives the already-flag-filtered tab list from the server layout and renders
 * it as a sub-navigation strip under the workspace header. Active-state detection
 * mirrors the admin sidebar's `isItemActive` (exact match for the Overview tab so
 * it isn't lit on every sub-route; prefix match for the rest).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { workspaceTabHref, type WorkspaceTab } from '@/lib/app/questionnaire/workspace-nav';
import { cn } from '@/lib/utils';

interface QuestionnaireSubNavProps {
  questionnaireId: string;
  versionId: string;
  tabs: readonly WorkspaceTab[];
}

function isTabActive(href: string, pathname: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function QuestionnaireSubNav({
  questionnaireId,
  versionId,
  tabs,
}: QuestionnaireSubNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Questionnaire sections"
      className="-mb-px flex items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const href = workspaceTabHref(questionnaireId, versionId, tab);
        const active = isTabActive(href, pathname, tab.exact);
        return (
          <Link
            key={tab.id}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              active
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
