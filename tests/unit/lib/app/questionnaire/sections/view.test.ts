/**
 * `buildSectionStripView` — the client-safe projection of section state (P21).
 *
 * Builds `SectionState` fixtures directly (mirroring the fixture style in `state.test.ts` and
 * `run.test.ts`), rather than routing through `buildSectionState`, so each branch can be pinned
 * without dragging in topics/questions/scope resolution that view.ts never touches.
 */

import { describe, expect, it } from 'vitest';

import {
  resumeSectionKey,
  onwardSectionKey,
  openingSectionKey,
  isInOpeningSection,
  buildSectionStripView,
  INERT_SECTION_STRIP,
  type SectionStripView,
  type SectionTabView,
} from '@/lib/app/questionnaire/sections/view';
import {
  closeSection,
  openSection,
  reconcileSectionRun,
  type SectionRun,
} from '@/lib/app/questionnaire/sections/run';
import type { SectionState } from '@/lib/app/questionnaire/sections/state';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';
import type { SectionCloseAssessment } from '@/lib/app/questionnaire/sections/close';

function section(key: string, ordinal: number): InterviewSection {
  return {
    key,
    label: `Section ${key}`,
    ordinal,
    source: 'topics',
    questionKeys: [`q_${key}`],
    dataSlotKeys: [],
  };
}

const SECTIONS = [section('a', 0), section('b', 1), section('c', 2)];

const freshRun = (): SectionRun => reconcileSectionRun(null, SECTIONS);

function assessment(overrides: Partial<CompletionAssessment> = {}): CompletionAssessment {
  return {
    kind: 'not_ready',
    rationale: 'test',
    unmet: [],
    coverage: 0,
    displayCoverage: 0,
    answeredCount: 0,
    requiredUnansweredKeys: [],
    capReached: false,
    earlyFinishAvailable: false,
    ...overrides,
  };
}

function closeAssessment(overrides: Partial<SectionCloseAssessment> = {}): SectionCloseAssessment {
  return {
    assessment: assessment(),
    canClose: false,
    blockedOnRequired: false,
    ...overrides,
  };
}

/** Build a full `SectionState`, defaulting to a fresh, un-navigated run over `SECTIONS`. */
function state(overrides: Partial<SectionState> = {}): SectionState {
  return {
    active: true,
    sections: SECTIONS,
    run: freshRun(),
    activeSection: null,
    isSectionOpening: false,
    close: null,
    allClosed: false,
    ...overrides,
  };
}

describe('buildSectionStripView: the inert gate', () => {
  it('returns the inert strip, by reference, when the state is not active', () => {
    const result = buildSectionStripView(state({ active: false, run: null }));
    expect(result).toBe(INERT_SECTION_STRIP);
  });

  it('returns the inert strip when active but the run is null', () => {
    // Not a state buildSectionState ever actually produces, but view.ts checks both
    // independently, so it is a branch worth pinning on its own.
    const result = buildSectionStripView(state({ active: true, run: null }));
    expect(result).toBe(INERT_SECTION_STRIP);
  });
});

describe('buildSectionStripView: navigation and availability', () => {
  it('marks every section available under free navigation, regardless of status', () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run }), { navigation: 'free' });
    expect(result.sections.every((s) => s.isAvailable)).toBe(true);
  });

  it('under sequential navigation, only the active, the closed, and the next open one are available', () => {
    // a is closed, b is active, c has never been opened.
    const run = closeSection(openSection(freshRun(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    const opened = openSection(run, 'b', 2);
    const result = buildSectionStripView(state({ run: opened }), { navigation: 'sequential' });

    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s.isAvailable]));
    expect(byKey.a).toBe(true); // closed sections keep the reopen right
    expect(byKey.b).toBe(true); // the active section
    expect(byKey.c).toBe(false); // not the active, not closed, not the next open one
  });

  it('defaults to sequential navigation when none is given', () => {
    // a is active and in_progress, so it is also the nextOpenKey; b and c are neither active,
    // closed, nor the next open section, so they read as unavailable under the default.
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run }));
    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s.isAvailable]));
    expect(byKey.a).toBe(true);
    expect(byKey.b).toBe(false);
    expect(byKey.c).toBe(false);
  });

  it('makes the next open section available under sequential navigation even before it is active', () => {
    // a closed, nothing opened yet: b is the next open section and should be reachable.
    const run = closeSection(openSection(freshRun(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    const result = buildSectionStripView(state({ run }), { navigation: 'sequential' });
    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s.isAvailable]));
    expect(byKey.b).toBe(true);
    expect(byKey.c).toBe(false);
  });

  it('keeps a visited section available after the respondent goes back to an earlier one', () => {
    // Mirrors `canOpenSection`'s visited clause. Without it the list re-locked the section they had
    // just been working in the moment they stepped back into section one.
    let run = closeSection(openSection(freshRun(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    run = openSection(run, 'b', 2);
    run = openSection(run, 'a', 3);
    const result = buildSectionStripView(state({ run }), { navigation: 'sequential' });
    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s.isAvailable]));
    expect(byKey.a).toBe(true); // active
    expect(byKey.b).toBe(true); // visited, left in progress
    expect(byKey.c).toBe(false); // never opened, and not the next open one
  });

  it('resolves nextOpenKey to null once every section is closed, so nothing is available on that basis alone', () => {
    let run = freshRun();
    for (const key of ['a', 'b', 'c']) {
      run = closeSection(openSection(run, key, 0), key, 1, 'respondent', SECTIONS);
    }
    const result = buildSectionStripView(state({ run, allClosed: true }), {
      navigation: 'sequential',
    });
    // Every section is available anyway, but on the CLOSED branch, not the next-open one.
    expect(result.sections.every((s) => s.isAvailable)).toBe(true);
    expect(result.sections.every((s) => s.status === 'closed')).toBe(true);
  });
});

describe('buildSectionStripView: the onward section once the active one can be finished', () => {
  // The state the respondent reported: a control offering "Move on to Growth Strategy" beside a
  // list drawing Growth Strategy with a padlock on it.
  const closeable = closeAssessment({ canClose: true });

  it('marks the onward section available under sequential navigation when the close gate is met', () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run, close: closeable }), {
      navigation: 'sequential',
    });
    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s]));
    expect(byKey.b.isAvailable).toBe(true);
    expect(byKey.b.finishesActive).toBe(true);
    // Only the ONE onward section opens up. Everything past it is still behind unfinished ground.
    expect(byKey.c.isAvailable).toBe(false);
    expect(byKey.c.finishesActive).toBe(false);
  });

  it('leaves the onward section locked while the active one cannot be finished', () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run, close: closeAssessment() }), {
      navigation: 'sequential',
    });
    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s]));
    expect(byKey.b.isAvailable).toBe(false);
    expect(byKey.b.finishesActive).toBe(false);
  });

  it("never sets finishesActive under free navigation, where a plain move is the respondent's right", () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run, close: closeable }), { navigation: 'free' });
    expect(result.sections.every((s) => s.isAvailable)).toBe(true);
    expect(result.sections.some((s) => s.finishesActive)).toBe(false);
  });

  it('skips a section already finished, naming the one the close actually hands the run to', () => {
    // b was worked through and closed early; a is active. Finishing a hands the run to c, not b.
    let run = closeSection(openSection(freshRun(), 'b', 0), 'b', 1, 'respondent', SECTIONS);
    run = openSection(run, 'a', 2);
    const result = buildSectionStripView(state({ run, close: closeable }), {
      navigation: 'sequential',
    });
    const byKey = Object.fromEntries(result.sections.map((s) => [s.key, s]));
    expect(byKey.c.finishesActive).toBe(true);
    expect(byKey.b.finishesActive).toBe(false);
  });

  it('sets it on no section when the active one is the last still open', () => {
    let run = freshRun();
    for (const key of ['a', 'b']) {
      run = closeSection(openSection(run, key, 0), key, 1, 'respondent', SECTIONS);
    }
    run = openSection(run, 'c', 2);
    const result = buildSectionStripView(state({ run, close: closeable }), {
      navigation: 'sequential',
    });
    expect(result.sections.some((s) => s.finishesActive)).toBe(false);
  });
});

describe('onwardSectionKey', () => {
  function tab(overrides: Partial<SectionTabView>): SectionTabView {
    return {
      key: 'x',
      label: 'X',
      position: 1,
      status: 'not_started',
      isActive: false,
      isAvailable: true,
      finishesActive: false,
      reopenCount: 0,
      ...overrides,
    };
  }

  it('returns the first section that is neither active nor closed', () => {
    expect(
      onwardSectionKey([
        tab({ key: 'a', status: 'closed' }),
        tab({ key: 'b', status: 'in_progress', isActive: true }),
        tab({ key: 'c' }),
      ])
    ).toBe('c');
  });

  it('skips a closed section rather than naming it, which position + 1 would have done', () => {
    expect(
      onwardSectionKey([
        tab({ key: 'a', status: 'in_progress', isActive: true }),
        tab({ key: 'b', status: 'closed' }),
        tab({ key: 'c' }),
      ])
    ).toBe('c');
  });

  it('returns null when the active section is the only one still open', () => {
    expect(
      onwardSectionKey([
        tab({ key: 'a', status: 'closed' }),
        tab({ key: 'b', status: 'in_progress', isActive: true }),
      ])
    ).toBeNull();
  });
});

describe('buildSectionStripView: activeKey resolution', () => {
  it('prefers state.activeSection over the run activeKey', () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run, activeSection: section('b', 1) }));
    expect(result.activeKey).toBe('b');
    expect(result.sections.find((s) => s.key === 'b')?.isActive).toBe(true);
    expect(result.sections.find((s) => s.key === 'a')?.isActive).toBe(false);
  });

  it('falls back to run.activeKey when activeSection is null', () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run, activeSection: null }));
    expect(result.activeKey).toBe('a');
    expect(result.sections.find((s) => s.key === 'a')?.isActive).toBe(true);
  });

  it('resolves to null when neither activeSection nor run.activeKey is set', () => {
    const result = buildSectionStripView(state({ run: freshRun(), activeSection: null }));
    expect(result.activeKey).toBeNull();
    expect(result.sections.every((s) => !s.isActive)).toBe(true);
  });
});

describe('buildSectionStripView: per-section projection', () => {
  it('falls back to not_started status and a zero reopenCount for a section missing from the run', () => {
    // The run only tracks 'a' and 'b'; the state carries an extra section 'c' the run never saw
    // (mirrors what reconcileSectionRun would fix on its next pass, but view.ts must not assume it
    // already ran).
    const run = reconcileSectionRun(null, [section('a', 0), section('b', 1)]);
    const result = buildSectionStripView(state({ sections: SECTIONS, run }), {
      navigation: 'free',
    });
    const c = result.sections.find((s) => s.key === 'c');
    expect(c).toMatchObject({ status: 'not_started', reopenCount: 0 });
  });

  it('carries the reopen count from the run entry', () => {
    let run = closeSection(openSection(freshRun(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    run = openSection(run, 'a', 2); // reopen
    const result = buildSectionStripView(state({ run }));
    expect(result.sections.find((s) => s.key === 'a')?.reopenCount).toBe(1);
  });

  it('reports position as 1-based over the resolved section order', () => {
    const result = buildSectionStripView(state({ run: freshRun() }));
    expect(result.sections.map((s) => [s.key, s.position])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });
});

describe('buildSectionStripView: the close gate', () => {
  it('reports canClose and blockedOnRequired false when close is null', () => {
    const result = buildSectionStripView(state({ close: null }));
    expect(result.canClose).toBe(false);
    expect(result.blockedOnRequired).toBe(false);
  });

  it('carries canClose and blockedOnRequired straight from a populated close assessment', () => {
    const result = buildSectionStripView(
      state({ close: closeAssessment({ canClose: true, blockedOnRequired: false }) })
    );
    expect(result.canClose).toBe(true);
    expect(result.blockedOnRequired).toBe(false);
  });

  it('surfaces blockedOnRequired independently of canClose', () => {
    const result = buildSectionStripView(
      state({ close: closeAssessment({ canClose: false, blockedOnRequired: true }) })
    );
    expect(result.canClose).toBe(false);
    expect(result.blockedOnRequired).toBe(true);
  });
});

describe('buildSectionStripView: allClosed and showLocked', () => {
  it('carries allClosed straight from state', () => {
    expect(buildSectionStripView(state({ allClosed: true })).allClosed).toBe(true);
    expect(buildSectionStripView(state({ allClosed: false })).allClosed).toBe(false);
  });

  it('defaults showLocked to true when opts omits it', () => {
    const result = buildSectionStripView(state());
    expect(result.showLocked).toBe(true);
  });

  it('honours an explicit showLocked: false', () => {
    const result = buildSectionStripView(state(), { showLocked: false });
    expect(result.showLocked).toBe(false);
  });

  it('honours an explicit showLocked: true', () => {
    const result = buildSectionStripView(state(), { showLocked: true });
    expect(result.showLocked).toBe(true);
  });

  it('defaults canGrow to false, so a fixed instrument promises nothing', () => {
    // The surface uses this to decide whether to say "more sections can appear". Defaulting the
    // other way would put that line on every questionnaire, including the ones whose list is
    // settled from the first turn.
    expect(buildSectionStripView(state()).canGrow).toBe(false);
  });

  it('carries canGrow when Conditional Topics is on', () => {
    // The only mechanism that adds a section mid-interview: the plan seats new topics as it lands,
    // and a respondent amendment can seat one later still.
    expect(buildSectionStripView(state(), { canGrow: true }).canGrow).toBe(true);
  });
});

describe('resumeSectionKey', () => {
  /** A view is cheap to hand-build here: this reads only `sections[].status` and nothing else. */
  const stripOf = (
    ...statuses: Array<'not_started' | 'in_progress' | 'closed'>
  ): SectionStripView => ({
    ...INERT_SECTION_STRIP,
    active: true,
    sections: statuses.map((status, i) => ({
      key: `s${i}`,
      label: `S${i}`,
      position: i + 1,
      status,
      isActive: false,
      isAvailable: true,
      finishesActive: false,
      reopenCount: 0,
    })),
  });

  it('is the first section that is not finished', () => {
    // The same rule the view builder uses for `nextOpenKey`, which is the point of exporting it:
    // the surface's "back to where we were" and the server's "what may they move to next" must not
    // drift into two different answers.
    expect(resumeSectionKey(stripOf('closed', 'in_progress', 'not_started'))).toBe('s1');
  });

  it('skips finished sections even when a later one is also finished', () => {
    expect(resumeSectionKey(stripOf('closed', 'not_started', 'closed'))).toBe('s1');
  });

  it('is the first section when nothing has been finished yet', () => {
    expect(resumeSectionKey(stripOf('not_started', 'not_started'))).toBe('s0');
  });

  it('is null when every section is finished', () => {
    // Nothing to continue to. The surface hides its way-back control on this, so a run that is
    // wholly closed does not offer to send anyone anywhere.
    expect(resumeSectionKey(stripOf('closed', 'closed'))).toBeNull();
  });

  it('is null for an unsectioned interview', () => {
    expect(resumeSectionKey(INERT_SECTION_STRIP)).toBeNull();
  });
});

describe('buildSectionStripView: the whole shape', () => {
  it('marks active: true and returns all resolved sections for a live sectioned run', () => {
    const run = openSection(freshRun(), 'a', 0);
    const result = buildSectionStripView(state({ run, activeSection: section('a', 0) }), {
      navigation: 'sequential',
      showLocked: true,
    });
    expect(result.active).toBe(true);
    expect(result.sections).toHaveLength(3);
    expect(result.activeKey).toBe('a');
  });
});

describe('openingSectionKey / isInOpeningSection', () => {
  const strip = (over: Partial<SectionStripView> = {}): SectionStripView => ({
    ...INERT_SECTION_STRIP,
    active: true,
    activeKey: 's0',
    sections: ['s0', 's1', 's2'].map((key, i) => ({
      key,
      label: `S${i}`,
      position: i + 1,
      status: 'not_started' as const,
      isActive: key === (over.activeKey ?? 's0'),
      isAvailable: true,
      finishesActive: false,
      reopenCount: 0,
    })),
    ...over,
  });

  it('names the first resolved section', () => {
    expect(openingSectionKey(strip())).toBe('s0');
  });

  it('is null on an unsectioned interview, which puts everything back on the flat path', () => {
    expect(openingSectionKey(INERT_SECTION_STRIP)).toBeNull();
    expect(isInOpeningSection(INERT_SECTION_STRIP)).toBe(true);
  });

  it('is true while the opening section is the active one', () => {
    expect(isInOpeningSection(strip({ activeKey: 's0' }))).toBe(true);
  });

  it('is false anywhere else', () => {
    // What this gates: the pre-release recording notice is a disclosure made once, at the head of
    // the conversation. It is not a turn, so the section filter never touched it, and it reappeared
    // above every section the respondent moved to.
    expect(isInOpeningSection(strip({ activeKey: 's1' }))).toBe(false);
    expect(isInOpeningSection(strip({ activeKey: 's2' }))).toBe(false);
  });

  it('counts a run with no active section as the opening', () => {
    // Before the first section opens, and once every one is closed: there is no section to be
    // somewhere else in.
    expect(isInOpeningSection(strip({ activeKey: null }))).toBe(true);
  });
});
