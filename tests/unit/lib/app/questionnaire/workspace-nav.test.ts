/**
 * Workspace navigation helpers — pure-function tests.
 *
 * workspaceVersionBase, workspaceTabHref, and visibleWorkspaceTabs are all
 * deterministic; no mocks required.
 */

import { describe, it, expect } from 'vitest';

import {
  QUESTIONNAIRE_WORKSPACE_TABS,
  QUESTIONNAIRE_WORKSPACE_GROUPS,
  workspaceVersionBase,
  workspaceTabHref,
  visibleWorkspaceTabs,
  visibleWorkspaceGroups,
  dimmedWorkspacePhases,
} from '@/lib/app/questionnaire/workspace-nav';
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeFlags(over: Partial<QuestionnaireWorkspaceFlags> = {}): QuestionnaireWorkspaceFlags {
  return {
    master: true,
    dataSlots: true,
    designEval: true,
    liveSessions: true,
    adaptive: true,
    adaptiveDataSlots: true,
    respondentReport: true,
    cohortReport: true,
    reportWebSearch: true,
    introScreen: false,
    personaSelection: false,
    advisor: true,
    editAgent: true,
    ...over,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('workspaceVersionBase', () => {
  it('returns the expected version workspace path', () => {
    expect(workspaceVersionBase('qn-1', 'ver-1')).toBe('/admin/questionnaires/qn-1/v/ver-1');
  });

  it('interpolates arbitrary id and versionId values correctly', () => {
    expect(workspaceVersionBase('abc', 'xyz')).toBe('/admin/questionnaires/abc/v/xyz');
  });
});

describe('workspaceTabHref', () => {
  it('returns the version base for the overview tab (empty segment)', () => {
    const overview = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'overview');
    expect(overview, 'overview tab missing from QUESTIONNAIRE_WORKSPACE_TABS').toBeDefined();
    // overview.segment is '' so href === base
    expect(workspaceTabHref('qn-1', 'ver-1', overview!)).toBe('/admin/questionnaires/qn-1/v/ver-1');
  });

  it('appends the segment for a non-overview tab', () => {
    const structure = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'structure');
    expect(structure, 'structure tab missing from QUESTIONNAIRE_WORKSPACE_TABS').toBeDefined();
    expect(workspaceTabHref('qn-1', 'ver-1', structure!)).toBe(
      '/admin/questionnaires/qn-1/v/ver-1/structure'
    );
  });

  it('appends the correct segment for the data-slots tab', () => {
    const ds = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'data-slots');
    expect(ds, 'data-slots tab missing from QUESTIONNAIRE_WORKSPACE_TABS').toBeDefined();
    expect(workspaceTabHref('qn-1', 'ver-1', ds!)).toBe(
      '/admin/questionnaires/qn-1/v/ver-1/data-slots'
    );
  });

  it('appends the correct segment for the evaluations tab', () => {
    const evals = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'evaluations');
    expect(evals, 'evaluations tab missing from QUESTIONNAIRE_WORKSPACE_TABS').toBeDefined();
    expect(workspaceTabHref('qn-1', 'ver-1', evals!)).toBe(
      '/admin/questionnaires/qn-1/v/ver-1/evaluations'
    );
  });
});

describe('visibleWorkspaceTabs', () => {
  it('returns all tabs when all flags are on', () => {
    const tabs = visibleWorkspaceTabs(makeFlags());
    const ids = tabs.map((t) => t.id);
    expect(ids).toContain('overview');
    expect(ids).toContain('structure');
    expect(ids).toContain('data-slots');
    expect(ids).toContain('evaluations');
    expect(ids).toContain('invitations');
    expect(ids).toContain('respondent-report');
    expect(ids).toContain('analytics');
  });

  it('hides the respondent-report tab when the respondentReport flag is off', () => {
    const tabs = visibleWorkspaceTabs(makeFlags({ respondentReport: false }));
    expect(tabs.find((t) => t.id === 'respondent-report')).toBeUndefined();
  });

  it('hides the data-slots tab when the dataSlots flag is off', () => {
    const tabs = visibleWorkspaceTabs(makeFlags({ dataSlots: false }));
    expect(tabs.find((t) => t.id === 'data-slots')).toBeUndefined();
  });

  it('hides the evaluations tab when the designEval flag is off', () => {
    const tabs = visibleWorkspaceTabs(makeFlags({ designEval: false }));
    expect(tabs.find((t) => t.id === 'evaluations')).toBeUndefined();
  });

  it('keeps always-on tabs (overview, structure, invitations, analytics, settings, changes) regardless of sub-flags', () => {
    const tabs = visibleWorkspaceTabs(makeFlags({ dataSlots: false, designEval: false }));
    const ids = tabs.map((t) => t.id);
    expect(ids).toContain('overview');
    expect(ids).toContain('structure');
    expect(ids).toContain('invitations');
    expect(ids).toContain('analytics');
    expect(ids).toContain('extraction-changes');
    expect(ids).toContain('settings');
  });

  it('returns an empty-ish list when all sub-flag tabs are hidden', () => {
    const tabs = visibleWorkspaceTabs(
      makeFlags({
        dataSlots: false,
        designEval: false,
        respondentReport: false,
        cohortReport: false,
        reportWebSearch: false,
        liveSessions: false,
      })
    );
    // Every flag-gated tab (data-slots, sessions, respondent-report, scoring, evaluations)
    // must be hidden once its flag is off — only the always-on tabs remain.
    const flaggedTabIds = QUESTIONNAIRE_WORKSPACE_TABS.filter((t) => t.flag).map((t) => t.id);
    for (const id of flaggedTabIds) {
      expect(tabs.find((t) => t.id === id)).toBeUndefined();
    }
  });

  it('preserves the display order from QUESTIONNAIRE_WORKSPACE_TABS', () => {
    const tabs = visibleWorkspaceTabs(makeFlags());
    // Must be a strict subset of the source order — no reordering
    const expectedOrder = QUESTIONNAIRE_WORKSPACE_TABS.map((t) => t.id);
    const actualOrder = tabs.map((t) => t.id);
    let prevIdx = -1;
    for (const id of actualOrder) {
      const idx = expectedOrder.indexOf(id);
      expect(idx).toBeGreaterThan(prevIdx);
      prevIdx = idx;
    }
  });
});

// ─── Lifecycle grouping ─────────────────────────────────────────────────────

describe('QUESTIONNAIRE_WORKSPACE_GROUPS', () => {
  it('partitions every workspace tab into exactly one group', () => {
    const grouped = QUESTIONNAIRE_WORKSPACE_GROUPS.flatMap((g) => g.tabIds);
    const tabIds = QUESTIONNAIRE_WORKSPACE_TABS.map((t) => t.id);

    // No duplicates across groups.
    expect(new Set(grouped).size).toBe(grouped.length);
    // Exact same set of ids (every tab grouped, no phantom ids).
    expect([...grouped].sort()).toEqual([...tabIds].sort());
  });

  it('only references tab ids that exist in QUESTIONNAIRE_WORKSPACE_TABS', () => {
    const known = new Set(QUESTIONNAIRE_WORKSPACE_TABS.map((t) => t.id));
    for (const group of QUESTIONNAIRE_WORKSPACE_GROUPS) {
      for (const id of group.tabIds) {
        expect(known.has(id), `group "${group.id}" references unknown tab "${id}"`).toBe(true);
      }
    }
  });

  it('leads with Overview and ends with Settings', () => {
    expect(QUESTIONNAIRE_WORKSPACE_GROUPS[0]?.id).toBe('overview');
    expect(QUESTIONNAIRE_WORKSPACE_GROUPS.at(-1)?.id).toBe('settings');
  });
});

describe('visibleWorkspaceGroups', () => {
  it('returns all five groups when every flag is on', () => {
    const groups = visibleWorkspaceGroups(makeFlags());
    expect(groups.map((g) => g.id)).toEqual([
      'overview',
      'build',
      'distribute',
      'results',
      'settings',
    ]);
  });

  it('reduces a group to only its always-visible tabs when flag-gated tabs are off', () => {
    // Every group owns at least one flag-free tab (Results has Analytics), so a group is
    // never fully emptied by flags — the `tabs.length === 0` drop guard stays defensive.
    // Here Results collapses to just Analytics once the two report tabs are gated off.
    const groups = visibleWorkspaceGroups(
      makeFlags({ cohortReport: false, respondentReport: false })
    );
    const results = groups.find((g) => g.id === 'results');
    expect(results?.tabs.map((t) => t.id)).toEqual(['analytics']);
  });

  it('keeps only the flag-visible tabs within a group, in registry order', () => {
    const groups = visibleWorkspaceGroups(makeFlags({ dataSlots: false }));
    const build = groups.find((g) => g.id === 'build');
    expect(build?.tabs.map((t) => t.id)).toEqual([
      'structure',
      'evaluations',
      'extraction-changes',
    ]);
  });

  it('carries the lifecycle phase through for build/distribute/results only', () => {
    const groups = visibleWorkspaceGroups(makeFlags());
    const phaseById = Object.fromEntries(groups.map((g) => [g.id, g.phase]));
    expect(phaseById.overview).toBeUndefined();
    expect(phaseById.settings).toBeUndefined();
    expect(phaseById.build).toBe('build');
    expect(phaseById.distribute).toBe('distribute');
    expect(phaseById.results).toBe('results');
  });
});

describe('dimmedWorkspacePhases', () => {
  it('dims distribute + results for a draft', () => {
    expect(dimmedWorkspacePhases('draft')).toEqual(['distribute', 'results']);
  });

  it('dims distribute for an archived questionnaire', () => {
    expect(dimmedWorkspacePhases('archived')).toEqual(['distribute']);
  });

  it('dims nothing for a launched questionnaire', () => {
    expect(dimmedWorkspacePhases('launched')).toEqual([]);
  });
});
