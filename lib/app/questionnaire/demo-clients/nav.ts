/**
 * Declarative tab registry for the demo-client **detail** surface.
 *
 * One row per tab in the sub-navigation bar, in display order — the sibling of
 * `workspace-nav.ts` for questionnaires. The client `<DemoClientSubNav>` builds
 * hrefs from these and applies active-state detection; the shared layout renders
 * them under the sticky header.
 *
 * Every tab applies to every demo client, so the list is near-static — only the
 * Cohorts & Rounds pair is conditional (see {@link DEMO_CLIENT_COHORT_TABS}). Kept
 * as plain data inside the framework-agnostic `lib/app/**` boundary so it stays SSR-safe.
 *
 * Every tab is nested under `/admin/demo-clients/[id]/<segment>`.
 */

export interface DemoClientTab {
  /** Stable id (also used as the React key). */
  id: string;
  /** Visible label in the tab bar. */
  label: string;
  /** Path suffix after `…/[id]`. Empty string = the Overview landing tab. */
  segment: string;
  /** Overview must match exactly so it isn't active on every sub-route. */
  exact?: boolean;
}

export const DEMO_CLIENT_TABS: readonly DemoClientTab[] = [
  { id: 'overview', label: 'Overview', segment: '', exact: true },
  { id: 'branding', label: 'Branding', segment: 'branding' },
  { id: 'knowledge', label: 'Knowledge', segment: 'knowledge' },
  { id: 'management', label: 'Management', segment: 'management' },
];

/**
 * The Cohorts & Rounds tabs — appended to the sub-nav only when `cohortsEnabled` is set
 * (decided server-side in the layout and threaded down to the client sub-nav). Inserted
 * before Management so the destructive demo-ops tab stays last.
 */
export const DEMO_CLIENT_COHORT_TABS: readonly DemoClientTab[] = [
  { id: 'cohorts', label: 'Cohorts', segment: 'cohorts' },
  { id: 'rounds', label: 'Rounds', segment: 'rounds' },
];

/**
 * Resolve the visible tab list. The cohorts/rounds tabs are opt-in via `cohortsEnabled`;
 * everything else is always shown, with Management kept last. Pure — the caller decides.
 */
export function demoClientTabs(opts: { cohortsEnabled: boolean }): readonly DemoClientTab[] {
  if (!opts.cohortsEnabled) return DEMO_CLIENT_TABS;
  const rest = DEMO_CLIENT_TABS.filter((t) => t.id !== 'management');
  const management = DEMO_CLIENT_TABS.filter((t) => t.id === 'management');
  return [...rest, ...DEMO_CLIENT_COHORT_TABS, ...management];
}

/** Base path for a demo-client detail surface. */
export function demoClientBase(id: string): string {
  return `/admin/demo-clients/${id}`;
}

/** Absolute href for a tab within a given demo client. */
export function demoClientTabHref(id: string, tab: DemoClientTab): string {
  const base = demoClientBase(id);
  return tab.segment ? `${base}/${tab.segment}` : base;
}
