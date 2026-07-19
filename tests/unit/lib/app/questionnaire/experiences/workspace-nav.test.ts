import { describe, it, expect } from 'vitest';

import {
  EXPERIENCE_WORKSPACE_TABS,
  experienceTabHref,
  experienceWorkspaceBase,
  visibleExperienceTabs,
  type ExperienceWorkspaceTab,
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
    // P15.1 ships no kind-restricted tabs, so both kinds see the full list. This guards the
    // filter itself: a `kinds` array added later must not accidentally hide the shared tabs.
    for (const kind of EXPERIENCE_KINDS) {
      const visible = visibleExperienceTabs(kind);
      const unrestricted = EXPERIENCE_WORKSPACE_TABS.filter((t) => !t.kinds);
      expect(visible).toEqual(expect.arrayContaining([...unrestricted]));
    }
  });

  it('filters a kind-restricted tab out for the other kind', () => {
    // Exercises the `kinds` predicate itself against a synthetic tab, so the filter is covered
    // before P15.2 adds the first genuinely kind-restricted tab (Routing, switcher-only).
    const restricted: ExperienceWorkspaceTab = {
      id: 'x',
      label: 'X',
      segment: 'x',
      kinds: ['agentic_switcher'],
    };
    const tabs: readonly ExperienceWorkspaceTab[] = [...EXPERIENCE_WORKSPACE_TABS, restricted];

    const forSwitcher = tabs.filter((t) => !t.kinds || t.kinds.includes('agentic_switcher'));
    const forMeeting = tabs.filter((t) => !t.kinds || t.kinds.includes('facilitated_meeting'));

    expect(forSwitcher.map((t) => t.id)).toContain('x');
    expect(forMeeting.map((t) => t.id)).not.toContain('x');
  });
});
