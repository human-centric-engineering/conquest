import { describe, it, expect } from 'vitest';

import {
  EXPERIENCE_WORKSPACE_TABS,
  experienceTabHref,
  experienceWorkspaceBase,
  visibleExperienceTabs,
} from '@/lib/app/questionnaire/experiences/workspace-nav';
import { EXPERIENCE_KINDS } from '@/lib/app/questionnaire/experiences/types';

describe('experience workspace nav', () => {
  it('gives every tab a unique id', () => {
    const ids = EXPERIENCE_WORKSPACE_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has exactly one exact-match tab, and it is the Overview landing tab', () => {
    // Overview must match exactly or it lights up on every sub-route; every other tab matches on
    // prefix so its own children keep it lit. More than one exact tab means one of them is wrong.
    const exact = EXPERIENCE_WORKSPACE_TABS.filter((t) => t.exact);
    expect(exact).toHaveLength(1);
    expect(exact[0].id).toBe('overview');
    expect(exact[0].segment).toBe('');
  });

  it('builds the overview href without a trailing segment', () => {
    const overview = EXPERIENCE_WORKSPACE_TABS.find((t) => t.id === 'overview')!;
    expect(experienceTabHref('exp_1', overview)).toBe('/admin/experiences/exp_1');
    expect(experienceWorkspaceBase('exp_1')).toBe('/admin/experiences/exp_1');
  });

  it('builds nested hrefs under the experience base', () => {
    const steps = EXPERIENCE_WORKSPACE_TABS.find((t) => t.id === 'steps')!;
    expect(experienceTabHref('exp_1', steps)).toBe('/admin/experiences/exp_1/steps');
  });

  it('shows every unrestricted tab for both experience kinds', () => {
    // Unrestricted tabs are the shared spine of the nav — a `kinds` array added to a restricted
    // tab must never accidentally hide them from either kind.
    for (const kind of EXPERIENCE_KINDS) {
      const visible = visibleExperienceTabs(kind);
      const unrestricted = EXPERIENCE_WORKSPACE_TABS.filter((t) => !t.kinds);
      expect(visible).toEqual(expect.arrayContaining([...unrestricted]));
    }
  });

  it('filters a kind-restricted tab out for the other kind', () => {
    // Exercises the real `kinds` predicate through `visibleExperienceTabs` against the shipped
    // restricted tabs: Routing is switcher-only, Meetings is facilitated-only. Asserting both
    // directions is what catches an inverted or dropped condition in the filter.
    const switcherIds = visibleExperienceTabs('agentic_switcher').map((t) => t.id);
    const meetingIds = visibleExperienceTabs('facilitated_meeting').map((t) => t.id);

    expect(switcherIds).toContain('routing');
    expect(switcherIds).not.toContain('meetings');

    expect(meetingIds).toContain('meetings');
    expect(meetingIds).not.toContain('routing');
  });

  it('declares each restricted tab against a real experience kind', () => {
    // A `kinds` entry that doesn't match a known kind would silently hide the tab everywhere.
    for (const tab of EXPERIENCE_WORKSPACE_TABS) {
      for (const kind of tab.kinds ?? []) {
        expect(EXPERIENCE_KINDS).toContain(kind);
      }
    }
  });
});
