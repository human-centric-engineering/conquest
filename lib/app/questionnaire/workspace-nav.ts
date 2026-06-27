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
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';
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
  // Sessions only exist once the live respondent surface is on, so gate the tab on it.
  { id: 'sessions', label: 'Sessions', segment: 'sessions', flag: 'liveSessions' },
  {
    id: 'respondent-report',
    label: 'Respondent report',
    segment: 'respondent-report',
    flag: 'respondentReport',
  },
  { id: 'scoring', label: 'Scoring', segment: 'scoring', flag: 'cohortReport' },
  { id: 'cohort-report', label: 'Report', segment: 'cohort-report', flag: 'cohortReport' },
  { id: 'analytics', label: 'Analytics', segment: 'analytics' },
  // Diagnostics surfaces per-invitation telemetry + the error log — meaningless without live
  // respondent sessions, so it shares the `liveSessions` gate (error CAPTURE is always-on regardless).
  { id: 'diagnostics', label: 'Diagnostics', segment: 'diagnostics', flag: 'liveSessions' },
  { id: 'evaluations', label: 'Evaluations', segment: 'evaluations', flag: 'designEval' },
  { id: 'extraction-changes', label: 'Extraction log', segment: 'extraction-changes' },
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

/* -------------------------------------------------------------------------- */
/* Lifecycle grouping (two-tier sub-navigation)                               */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle phase a group of tabs belongs to. Drives draft/launched
 * emphasis: a phase that holds nothing meaningful yet (no respondents, no
 * results) is dimmed rather than hidden. Overview and Settings have no phase —
 * they are always relevant.
 */
export type WorkspacePhase = 'build' | 'distribute' | 'results';

/** One lifecycle group in the top tier of the workspace sub-nav. */
export interface WorkspaceGroup {
  /** Stable id (also the React key). */
  id: string;
  /** Visible label in the top-tier bar. */
  label: string;
  /** Lifecycle phase for dim logic; omitted for the always-relevant Overview / Settings. */
  phase?: WorkspacePhase;
  /** Tab ids in this group, in display order. Every id must exist in `QUESTIONNAIRE_WORKSPACE_TABS`. */
  tabIds: readonly string[];
}

/**
 * Lifecycle grouping of the 13 workspace tabs into the four life-stages of a
 * questionnaire — Overview · Build · Distribute · Results — plus a standalone
 * Settings. The flat `QUESTIONNAIRE_WORKSPACE_TABS` stays the source of truth
 * (hrefs, flags, intra-group order); this layer only adds the two-tier shape the
 * sub-nav renders. **Every workspace tab id appears in exactly one group** — the
 * unit test asserts the partition so a new tab can't silently fall out of the nav.
 */
export const QUESTIONNAIRE_WORKSPACE_GROUPS: readonly WorkspaceGroup[] = [
  { id: 'overview', label: 'Overview', tabIds: ['overview'] },
  {
    id: 'build',
    label: 'Build',
    phase: 'build',
    tabIds: ['structure', 'data-slots', 'evaluations', 'extraction-changes'],
  },
  {
    id: 'distribute',
    label: 'Distribute',
    phase: 'distribute',
    tabIds: ['invitations', 'sessions', 'diagnostics'],
  },
  {
    id: 'results',
    label: 'Results',
    phase: 'results',
    tabIds: ['analytics', 'respondent-report', 'scoring', 'cohort-report'],
  },
  { id: 'settings', label: 'Settings', tabIds: ['settings'] },
];

/** A group projected to its currently-visible (flag-filtered) tabs. */
export interface ResolvedWorkspaceGroup {
  id: string;
  label: string;
  phase?: WorkspacePhase;
  tabs: readonly WorkspaceTab[];
}

/**
 * Project the flag-filtered tabs into their lifecycle groups, dropping any group
 * left empty by feature flags (e.g. Results collapses to a single tab — or
 * vanishes — when the report flags are off). Intra-group order follows
 * `QUESTIONNAIRE_WORKSPACE_GROUPS`; the flag filter is the single one in
 * `visibleWorkspaceTabs`, so the two stay in lock-step.
 */
export function visibleWorkspaceGroups(
  flags: QuestionnaireWorkspaceFlags
): readonly ResolvedWorkspaceGroup[] {
  const byId = new Map(visibleWorkspaceTabs(flags).map((tab) => [tab.id, tab]));
  const resolved: ResolvedWorkspaceGroup[] = [];
  for (const group of QUESTIONNAIRE_WORKSPACE_GROUPS) {
    const tabs = group.tabIds
      .map((id) => byId.get(id))
      .filter((tab): tab is WorkspaceTab => tab !== undefined);
    if (tabs.length === 0) continue;
    resolved.push({
      id: group.id,
      label: group.label,
      ...(group.phase ? { phase: group.phase } : {}),
      tabs,
    });
  }
  return resolved;
}

/**
 * Which lifecycle phases to de-emphasize for a given status — the phases that
 * hold nothing actionable yet. A draft has neither respondents nor results; an
 * archived questionnaire takes no new respondents. Dimmed groups stay clickable
 * (an admin may still want to peek); this is emphasis, not access control.
 */
export function dimmedWorkspacePhases(status: AppQuestionnaireStatus): readonly WorkspacePhase[] {
  switch (status) {
    case 'draft':
      return ['distribute', 'results'];
    case 'archived':
      return ['distribute'];
    case 'launched':
      return [];
  }
}
