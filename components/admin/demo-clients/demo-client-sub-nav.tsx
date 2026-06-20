'use client';

/**
 * Horizontal tab bar for the demo-client detail surface — the sibling of
 * `<QuestionnaireSubNav>`.
 *
 * Renders the demo-client tab registry as a sub-navigation strip under the
 * detail header. Active-state detection mirrors the workspace sub-nav (exact
 * match for the Overview tab so it isn't lit on every sub-route; prefix match
 * for the rest), and the visual treatment is identical so the two app surfaces
 * read as a cohesive pair.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { demoClientTabHref, demoClientTabs } from '@/lib/app/questionnaire/demo-clients/nav';
import { cn } from '@/lib/utils';

interface DemoClientSubNavProps {
  clientId: string;
  /** Whether the Cohorts & Rounds tabs are shown (the `APP_QUESTIONNAIRES_COHORTS` flag). */
  cohortsEnabled?: boolean;
}

function isTabActive(href: string, pathname: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function DemoClientSubNav({ clientId, cohortsEnabled = false }: DemoClientSubNavProps) {
  const pathname = usePathname();
  const tabs = demoClientTabs({ cohortsEnabled });

  return (
    <nav
      aria-label="Demo client sections"
      className="-mb-px flex items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const href = demoClientTabHref(clientId, tab);
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
