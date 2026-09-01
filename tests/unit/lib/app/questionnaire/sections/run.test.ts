/**
 * The per-session section run: narrowing, reconciliation, and the moves.
 *
 * Two things are worth guarding hardest. First the failure direction: an unreadable blob must read
 * as "not sectioned", because being stuck in a section a corrupt blob claims you are in is a broken
 * session. Second reconciliation, because sections genuinely appear mid-interview when a
 * Conditional Topics plan lands, and an entry whose section stops resolving must not be dropped —
 * turns are already tagged with it.
 */

import { describe, expect, it } from 'vitest';

import {
  allSectionsClosed,
  canOpenSection,
  closeSection,
  narrowSectionRun,
  nextOpenSectionKey,
  openSection,
  reconcileSectionRun,
  recordTurnInSection,
  sectionEntry,
  type SectionRun,
} from '@/lib/app/questionnaire/sections/run';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';

function section(key: string, ordinal: number): InterviewSection {
  return {
    key,
    label: key,
    ordinal,
    source: 'topics',
    questionKeys: [`q_${key}`],
    dataSlotKeys: [],
  };
}

const SECTIONS = [section('a', 0), section('b', 1), section('c', 2)];

const fresh = (): SectionRun => reconcileSectionRun(null, SECTIONS);

describe('narrowSectionRun', () => {
  it.each([null, undefined, 'x', 7, [], {}, { v: 2, sections: [] }])(
    'reads %p as not sectioned',
    (value) => {
      expect(narrowSectionRun(value)).toBeNull();
    }
  );

  it('drops an entry with no key, and a duplicate key', () => {
    const run = narrowSectionRun({
      v: 1,
      activeKey: 'a',
      sections: [
        { key: 'a', status: 'in_progress' },
        { key: '', status: 'closed' },
        // A duplicate would make the run ambiguous: two entries claiming one section.
        { key: 'a', status: 'closed' },
      ],
    });
    expect(run?.sections.map((s) => s.key)).toEqual(['a']);
    expect(run?.sections[0]?.status).toBe('in_progress');
  });

  it('drops an active key naming a section it does not track', () => {
    // Otherwise the conversation would be bounded to a section nothing can report on or close.
    const run = narrowSectionRun({
      v: 1,
      activeKey: 'ghost',
      sections: [{ key: 'a', status: 'in_progress' }],
    });
    expect(run?.activeKey).toBeNull();
  });

  it('drops a close stamp on a section that is not closed', () => {
    const run = narrowSectionRun({
      v: 1,
      activeKey: 'a',
      sections: [{ key: 'a', status: 'in_progress', closedAtTurn: 9, closeReason: 'respondent' }],
    });
    expect(run?.sections[0]).toMatchObject({ closedAtTurn: null, closeReason: null });
  });

  it('falls back to not_started for an unreadable status', () => {
    const run = narrowSectionRun({ v: 1, sections: [{ key: 'a', status: 'wat' }] });
    expect(run?.sections[0]?.status).toBe('not_started');
  });
});

describe('reconcileSectionRun', () => {
  it('creates an entry for every resolved section', () => {
    const run = fresh();
    expect(run.sections.map((s) => s.key)).toEqual(['a', 'b', 'c']);
    expect(run.sections.every((s) => s.status === 'not_started')).toBe(true);
    expect(run.activeKey).toBeNull();
  });

  it('adds a section that appeared mid-interview without disturbing the others', () => {
    let run = openSection(fresh(), 'a', 0);
    run = recordTurnInSection(run, 'a');
    const widened = reconcileSectionRun(run, [...SECTIONS, section('late', 3)]);
    expect(widened.sections.map((s) => s.key)).toEqual(['a', 'b', 'c', 'late']);
    expect(sectionEntry(widened, 'a')).toMatchObject({ status: 'in_progress', turnsSpent: 1 });
    expect(widened.activeKey).toBe('a');
  });

  it('keeps an entry whose section stopped resolving, so its turns are not orphaned', () => {
    const run = closeSection(openSection(fresh(), 'b', 0), 'b', 3, 'respondent', SECTIONS);
    const narrowed = reconcileSectionRun(run, [section('a', 0), section('c', 1)]);
    expect(narrowed.sections.map((s) => s.key)).toEqual(['a', 'c', 'b']);
    expect(sectionEntry(narrowed, 'b')?.status).toBe('closed');
  });

  it('clears an active key whose section stopped resolving', () => {
    const run = openSection(fresh(), 'b', 0);
    expect(reconcileSectionRun(run, [section('a', 0), section('c', 1)]).activeKey).toBeNull();
  });
});

describe('openSection', () => {
  it('opens a fresh section and stamps where it starts', () => {
    const run = openSection(fresh(), 'a', 4);
    expect(sectionEntry(run, 'a')).toMatchObject({ status: 'in_progress', openedAtTurn: 4 });
    expect(run.activeKey).toBe('a');
  });

  it('reopens a closed section, bumping the count but keeping where it started', () => {
    // `openedAtTurn` answers "where in the transcript does this section begin", and coming back to
    // it does not change that.
    let run = openSection(fresh(), 'a', 2);
    run = closeSection(run, 'a', 6, 'respondent', SECTIONS);
    run = openSection(run, 'a', 11);
    expect(sectionEntry(run, 'a')).toMatchObject({
      status: 'in_progress',
      openedAtTurn: 2,
      closedAtTurn: null,
      closeReason: null,
      reopenCount: 1,
    });
  });
});

describe('closeSection', () => {
  it('closes and hands the run to the next open section', () => {
    const run = closeSection(openSection(fresh(), 'a', 0), 'a', 3, 'respondent', SECTIONS);
    expect(sectionEntry(run, 'a')).toMatchObject({
      status: 'closed',
      closedAtTurn: 3,
      closeReason: 'respondent',
    });
    expect(run.activeKey).toBe('b');
  });

  it('leaves no active section once every one is closed', () => {
    let run = fresh();
    for (const key of ['a', 'b', 'c']) {
      run = closeSection(openSection(run, key, 0), key, 1, 'respondent', SECTIONS);
    }
    expect(run.activeKey).toBeNull();
    expect(allSectionsClosed(run, SECTIONS)).toBe(true);
  });

  it('is a no-op on a section already closed, so a double-tap cannot re-stamp it', () => {
    const once = closeSection(openSection(fresh(), 'a', 0), 'a', 3, 'respondent', SECTIONS);
    const twice = closeSection(once, 'a', 9, 'cap', SECTIONS);
    expect(twice).toBe(once);
  });
});

describe('recordTurnInSection', () => {
  it('charges the turn to the section it was spent in', () => {
    let run = openSection(fresh(), 'a', 0);
    run = recordTurnInSection(run, 'a');
    run = recordTurnInSection(run, 'a');
    expect(sectionEntry(run, 'a')?.turnsSpent).toBe(2);
    expect(sectionEntry(run, 'b')?.turnsSpent).toBe(0);
  });

  it('counts across visits, which is why it is not derived from openedAtTurn', () => {
    // Under free navigation the turns are not contiguous, so an ordinal-difference would charge
    // section a for every turn spent in b.
    let run = recordTurnInSection(openSection(fresh(), 'a', 0), 'a');
    run = recordTurnInSection(openSection(run, 'b', 1), 'b');
    run = recordTurnInSection(openSection(run, 'a', 2), 'a');
    expect(sectionEntry(run, 'a')?.turnsSpent).toBe(2);
    expect(sectionEntry(run, 'b')?.turnsSpent).toBe(1);
  });

  it('is a no-op for a key the run does not track', () => {
    const run = fresh();
    expect(recordTurnInSection(run, 'ghost')).toBe(run);
  });
});

describe('canOpenSection', () => {
  it('allows anything under free navigation', () => {
    const run = fresh();
    expect(canOpenSection(run, SECTIONS, 'c', 'free')).toBe(true);
  });

  it('refuses a jump past unfinished ground under sequential navigation', () => {
    const run = openSection(fresh(), 'a', 0);
    expect(canOpenSection(run, SECTIONS, 'c', 'sequential')).toBe(false);
    expect(canOpenSection(run, SECTIONS, 'a', 'sequential')).toBe(true);
  });

  it('allows the next section once the one before it is closed', () => {
    const run = closeSection(openSection(fresh(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    expect(canOpenSection(run, SECTIONS, 'b', 'sequential')).toBe(true);
    expect(canOpenSection(run, SECTIONS, 'c', 'sequential')).toBe(false);
  });

  it('always allows reopening a closed section, even under sequential navigation', () => {
    // The reopen right is not conditional on the navigation setting: a respondent who realises they
    // misspoke must be able to go back whatever order they are being held to going forward.
    let run = closeSection(openSection(fresh(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    run = openSection(run, 'b', 2);
    expect(canOpenSection(run, SECTIONS, 'a', 'sequential')).toBe(true);
  });

  it('refuses a section the run does not track', () => {
    expect(canOpenSection(fresh(), SECTIONS, 'ghost', 'free')).toBe(false);
  });
});

describe('nextOpenSectionKey', () => {
  it('is the first section not yet closed, in resolved order', () => {
    const run = closeSection(openSection(fresh(), 'a', 0), 'a', 1, 'respondent', SECTIONS);
    expect(nextOpenSectionKey(run, SECTIONS)).toBe('b');
  });

  it('is null when everything is closed', () => {
    let run = fresh();
    for (const key of ['a', 'b', 'c']) {
      run = closeSection(openSection(run, key, 0), key, 1, 'respondent', SECTIONS);
    }
    expect(nextOpenSectionKey(run, SECTIONS)).toBeNull();
  });
});
