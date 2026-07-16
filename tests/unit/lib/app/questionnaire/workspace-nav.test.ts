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
  it('returns all tabs — every questionnaire feature is permanently on', () => {
    const tabs = visibleWorkspaceTabs();
    const ids = tabs.map((t) => t.id);
    expect(ids).toContain('overview');
    expect(ids).toContain('structure');
    expect(ids).toContain('data-slots');
    expect(ids).toContain('evaluations');
    expect(ids).toContain('invitations');
    expect(ids).toContain('respondent-report');
    expect(ids).toContain('analytics');
  });

  it('preserves the display order from QUESTIONNAIRE_WORKSPACE_TABS', () => {
    const tabs = visibleWorkspaceTabs();
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
  it('returns all five groups', () => {
    const groups = visibleWorkspaceGroups();
    expect(groups.map((g) => g.id)).toEqual([
      'overview',
      'build',
      'distribute',
      'results',
      'settings',
    ]);
  });

  it('carries the lifecycle phase through for build/distribute/results only', () => {
    const groups = visibleWorkspaceGroups();
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
