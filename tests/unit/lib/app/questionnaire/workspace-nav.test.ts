/**
 * Workspace navigation helpers — pure-function tests.
 *
 * workspaceVersionBase, workspaceTabHref, and visibleWorkspaceTabs are all
 * deterministic; no mocks required.
 */

import { describe, it, expect } from 'vitest';

import {
  QUESTIONNAIRE_WORKSPACE_TABS,
  workspaceVersionBase,
  workspaceTabHref,
  visibleWorkspaceTabs,
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
    expect(ids).toContain('analytics');
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
    const tabs = visibleWorkspaceTabs(makeFlags({ dataSlots: false, designEval: false }));
    // data-slots and evaluations should be the only hidden ones
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
