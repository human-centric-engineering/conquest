/**
 * Declarative tab registry for the experience admin **workspace**.
 *
 * The sibling of `lib/app/questionnaire/workspace-nav.ts`, and deliberately built on the same
 * `WorkspaceTab` shape — imported, not redeclared — so both sub-navs stay structurally identical
 * and a change to the tab contract cannot drift between them.
 *
 * Simpler than the questionnaire workspace in two ways: an experience has no version segment (it
 * is not forked, so tabs nest directly under `/admin/experiences/[id]`), and there is no
 * lifecycle-phase grouping (the tab count stays small enough to read flat).
 *
 * Tabs appear as their phase lands. P15.1 ships Overview / Steps / Settings; Routing and Runs
 * arrive with the switcher runtime (P15.2), Reports with P15.4, Breakouts and Console with the
 * facilitated-meeting kind (P15.5).
 */
import type { WorkspaceTab } from '@/lib/app/questionnaire/workspace-nav';
import { type ExperienceKind } from '@/lib/app/questionnaire/experiences/types';

/**
 * Every experience workspace tab, in display order.
 *
 * `kinds` restricts a tab to particular experience kinds — a switcher has no breakouts, and a
 * facilitated meeting has no routing decision to configure. Omitted means the tab shows for every
 * kind. Filtering here rather than 404-ing the page keeps the nav honest: a tab that is visible
 * always leads somewhere real.
 */
export interface ExperienceWorkspaceTab extends WorkspaceTab {
  kinds?: readonly ExperienceKind[];
}

export const EXPERIENCE_WORKSPACE_TABS: readonly ExperienceWorkspaceTab[] = [
  { id: 'overview', label: 'Overview', segment: '', exact: true },
  { id: 'steps', label: 'Steps', segment: 'steps' },
  // Routing is switcher-only: a facilitated meeting has no fork to configure, so showing an empty
  // rules editor there would imply a decision that surface never makes.
  { id: 'routing', label: 'Routing', segment: 'routing', kinds: ['agentic_switcher'] },
  { id: 'runs', label: 'Runs', segment: 'runs' },
  // Reports are scoped PER STEP (F15.4), which is why they get their own tab rather than sitting
  // under Runs: a run is one respondent's journey, a report is every respondent who answered one
  // step of it. Two different questions about the same data.
  { id: 'reports', label: 'Reports', segment: 'reports' },
  // Meetings are facilitated-only: a switcher has no room to run, so showing the tab there would
  // imply an occurrence that surface never has.
  { id: 'meetings', label: 'Meetings', segment: 'meetings', kinds: ['facilitated_meeting'] },
  { id: 'settings', label: 'Settings', segment: 'settings' },
];

/** Base path for an experience workspace. */
export function experienceWorkspaceBase(id: string): string {
  return `/admin/experiences/${id}`;
}

/** Absolute href for a tab within a given experience. */
export function experienceTabHref(id: string, tab: ExperienceWorkspaceTab): string {
  const base = experienceWorkspaceBase(id);
  return tab.segment ? `${base}/${tab.segment}` : base;
}

/** The tabs applicable to one experience kind. */
export function visibleExperienceTabs(kind: ExperienceKind): readonly ExperienceWorkspaceTab[] {
  return EXPERIENCE_WORKSPACE_TABS.filter((tab) => !tab.kinds || tab.kinds.includes(kind));
}
