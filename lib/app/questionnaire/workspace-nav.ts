/**
 * Declarative tab registry for the questionnaire admin **workspace**.
 *
 * One row per tab in the sub-navigation bar, in display order. The client
 * `<QuestionnaireSubNav>` builds hrefs from these and applies active-state
 * detection; the server layout renders them all. Kept as plain data (not the
 * runtime sidebar registry) so it stays SSR-safe and inside the
 * framework-agnostic `lib/app/**` boundary.
 *
 * Every tab is nested under `/admin/questionnaires/[id]/v/[vid]/<segment>`.
 * Invitations is version-agnostic in its logic but lives under the version
 * segment so it inherits the shared workspace chrome (header + tabs); its page
 * ignores `vid` and targets the newest launched version, as before.
 */
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

export interface WorkspaceTab {
  /** Stable id (also used as the React key). */
  id: string;
  /** Visible label in the tab bar. */
  label: string;
  /** Path suffix after `…/v/[vid]`. Empty string = the Overview landing tab. */
  segment: string;
  /** Overview must match exactly so it isn't active on every sub-route. */
  exact?: boolean;
}

export const QUESTIONNAIRE_WORKSPACE_TABS: readonly WorkspaceTab[] = [
  { id: 'overview', label: 'Overview', segment: '', exact: true },
  { id: 'structure', label: 'Structure', segment: 'structure' },
  { id: 'data-slots', label: 'Data slots', segment: 'data-slots' },
  { id: 'invitations', label: 'Invitations', segment: 'invitations' },
  { id: 'sessions', label: 'Sessions', segment: 'sessions' },
  {
    id: 'respondent-report',
    label: 'Respondent report',
    segment: 'respondent-report',
  },
  { id: 'scoring', label: 'Scoring', segment: 'scoring' },
  { id: 'cohort-report', label: 'Report', segment: 'cohort-report' },
  { id: 'analytics', label: 'Analytics', segment: 'analytics' },
  { id: 'diagnostics', label: 'Diagnostics', segment: 'diagnostics' },
  { id: 'evaluations', label: 'Evaluations', segment: 'evaluations' },
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

/** The workspace tab list. Every questionnaire feature is permanently on, so all tabs show. */
export function visibleWorkspaceTabs(): readonly WorkspaceTab[] {
  return QUESTIONNAIRE_WORKSPACE_TABS;
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
 * Project the tabs into their lifecycle groups. Intra-group order follows
 * `QUESTIONNAIRE_WORKSPACE_GROUPS`. Every questionnaire feature is permanently
 * on, so no group is dropped for being empty.
 */
export function visibleWorkspaceGroups(): readonly ResolvedWorkspaceGroup[] {
  const byId = new Map(visibleWorkspaceTabs().map((tab) => [tab.id, tab]));
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
