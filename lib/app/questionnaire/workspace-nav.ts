/**
 * Declarative tab registry for the questionnaire admin **workspace**.
 *
 * One row per tab in the sub-navigation bar, in display order. The client
 * `<QuestionnaireSubNav>` builds hrefs from these and applies active-state
 * detection; the server layout filters them by resolved feature flags. Kept as
 * plain data (not the runtime sidebar registry) so it stays SSR-safe and inside
 * the framework-agnostic `lib/app/**` boundary.
 *
 * Every tab is nested under `/admin/questionnaires/[id]/v/[vid]/<segment>`.
 * Invitations is version-agnostic in its logic but lives under the version
 * segment so it inherits the shared workspace chrome (header + tabs); its page
 * ignores `vid` and targets the newest launched version, as before.
 */
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

export interface WorkspaceTab {
  /** Stable id (also used as the React key). */
  id: string;
  /** Visible label in the tab bar. */
  label: string;
  /** Path suffix after `…/v/[vid]`. Empty string = the Overview landing tab. */
  segment: string;
  /** Overview must match exactly so it isn't active on every sub-route. */
  exact?: boolean;
  /**
   * Flag field that must be `true` for the tab to show. Omitted = always shown
   * (the master flag is already enforced by the layout before any tab renders).
   */
  flag?: keyof QuestionnaireWorkspaceFlags;
}

export const QUESTIONNAIRE_WORKSPACE_TABS: readonly WorkspaceTab[] = [
  { id: 'overview', label: 'Overview', segment: '', exact: true },
  { id: 'structure', label: 'Structure', segment: 'structure' },
  { id: 'data-slots', label: 'Data slots', segment: 'data-slots', flag: 'dataSlots' },
  { id: 'invitations', label: 'Invitations', segment: 'invitations' },
  { id: 'analytics', label: 'Analytics', segment: 'analytics' },
  { id: 'evaluations', label: 'Evaluations', segment: 'evaluations', flag: 'designEval' },
  { id: 'extraction-changes', label: 'Changes', segment: 'extraction-changes' },
  { id: 'settings', label: 'Settings', segment: 'settings' },
];

/** Base path for a questionnaire version workspace. */
export function workspaceVersionBase(id: string, versionId: string): string {
  return `/admin/questionnaires/${id}/v/${versionId}`;
}

/** Absolute href for a tab within a given questionnaire + version. */
export function workspaceTabHref(id: string, versionId: string, tab: WorkspaceTab): string {
  const base = workspaceVersionBase(id, versionId);
  return tab.segment ? `${base}/${tab.segment}` : base;
}

/** Filter the tab list to those enabled by the resolved flags. */
export function visibleWorkspaceTabs(flags: QuestionnaireWorkspaceFlags): readonly WorkspaceTab[] {
  return QUESTIONNAIRE_WORKSPACE_TABS.filter((tab) => !tab.flag || flags[tab.flag]);
}
