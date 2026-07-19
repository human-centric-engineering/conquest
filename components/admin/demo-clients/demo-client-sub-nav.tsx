'use client';

/**
 * Sub-navigation strip for the demo-client detail surface — the sibling of
 * `<QuestionnaireSubNav>`.
 *
 * Demo clients have only a handful of tabs (4–6 with cohorts on), so they render
 * through the shared {@link GroupedSubNav} as a single flat group: one underline
 * row, visually identical to the questionnaire workspace's styling so the two app
 * surfaces read as a cohesive pair. hrefs are built here via the pure
 * `demoClientTabHref` helper.
 */
import { GroupedSubNav } from '@/components/admin/grouped-sub-nav';
import { demoClientTabHref, demoClientTabs } from '@/lib/app/questionnaire/demo-clients/nav';

interface DemoClientSubNavProps {
  clientId: string;
  /** Whether the Cohorts & Rounds tabs are shown. Callers pass `true` today. */
  cohortsEnabled?: boolean;
}

export function DemoClientSubNav({ clientId, cohortsEnabled = false }: DemoClientSubNavProps) {
  const tabs = demoClientTabs({ cohortsEnabled }).map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: demoClientTabHref(clientId, tab),
    ...(tab.exact ? { exact: true } : {}),
  }));

  return (
    <GroupedSubNav
      ariaLabel="Demo client sections"
      groups={[{ id: 'demo-client', label: 'Demo client', href: tabs[0].href, tabs }]}
    />
  );
}
