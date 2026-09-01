/**
 * Unit: report chapters (P21 phase D).
 *
 * The three judgements the chapter builder makes, each of which would be a silently wrong report if
 * it went the other way:
 *
 *  - the SECTIONS order the chapters, not the run, because the run's entry list is reconciled per
 *    turn and holds entries with no label to write a chapter under;
 *  - a part reached but not finished is COVERED (the writer has their answers), and only a part
 *    never reached earns the not-covered statement;
 *  - content belonging to no chapter is kept under a catch-all, never dropped to tidy the list.
 *
 * @see lib/app/questionnaire/report/chapters.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildReportChapters,
  chapterDataSlotGroups,
  chapterHeadingOrder,
  headingByDataSlotKey,
  headingByQuestionKey,
  UNCHAPTERED_HEADING,
  type ReportChapter,
} from '@/lib/app/questionnaire/report/chapters';
import type { SectionRun, SectionRunEntry } from '@/lib/app/questionnaire/sections/run';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';

function section(over: Partial<InterviewSection> & { key: string }): InterviewSection {
  return {
    label: over.key,
    ordinal: 0,
    source: 'topics',
    questionKeys: [],
    dataSlotKeys: [],
    ...over,
  };
}

function entry(key: string, status: SectionRunEntry['status']): SectionRunEntry {
  return {
    key,
    status,
    openedAtTurn: 1,
    closedAtTurn: status === 'closed' ? 4 : null,
    closeReason: status === 'closed' ? 'respondent' : null,
    reopenCount: 0,
    turnsSpent: 3,
  };
}

function run(entries: SectionRunEntry[], activeKey: string | null = null): SectionRun {
  return { v: 1, activeKey, sections: entries };
}

describe('buildReportChapters', () => {
  it('numbers the chapters from the resolved sections, in section order', () => {
    const chapters = buildReportChapters(
      [section({ key: 'a', label: 'Context' }), section({ key: 'b', label: 'Problem' })],
      // The run lists them the other way round: it is not the ordering authority.
      run([entry('b', 'closed'), entry('a', 'closed')])
    );
    expect(chapters.map((c) => [c.position, c.label])).toEqual([
      [1, 'Context'],
      [2, 'Problem'],
    ]);
  });

  it('marks a section the run never started as not covered', () => {
    const chapters = buildReportChapters(
      [section({ key: 'a' }), section({ key: 'b' })],
      run([entry('a', 'closed'), entry('b', 'not_started')])
    );
    expect(chapters.map((c) => c.covered)).toEqual([true, false]);
  });

  it('treats a section with no run entry at all as never reached', () => {
    // A section seated late by a plan the respondent never got to. Absent, not merely unstarted.
    const chapters = buildReportChapters(
      [section({ key: 'a' }), section({ key: 'late' })],
      run([entry('a', 'in_progress')])
    );
    expect(chapters.map((c) => c.covered)).toEqual([true, false]);
  });

  it('counts a section reached but not finished as covered', () => {
    // The respondent WAS there and their answers are in hand. A thin chapter is honest; an absent
    // one would claim the interview never went near it.
    const chapters = buildReportChapters([section({ key: 'a' })], run([entry('a', 'in_progress')]));
    expect(chapters[0]?.covered).toBe(true);
  });

  it('reads every section as not reached when there is no run at all', () => {
    const chapters = buildReportChapters([section({ key: 'a' }), section({ key: 'b' })], null);
    expect(chapters.every((c) => !c.covered)).toBe(true);
  });

  it('carries the membership through so content can be bucketed into it', () => {
    const chapters = buildReportChapters(
      [section({ key: 'a', questionKeys: ['q1'], dataSlotKeys: ['s1'] })],
      run([entry('a', 'closed')])
    );
    expect(chapters[0]?.questionKeys).toEqual(['q1']);
    expect(chapters[0]?.dataSlotKeys).toEqual(['s1']);
  });
});

describe('chapter heading indexes', () => {
  const chapters: ReportChapter[] = [
    {
      key: 'a',
      label: 'Context',
      position: 1,
      covered: true,
      questionKeys: ['q1', 'shared'],
      dataSlotKeys: ['s1', 'shared'],
    },
    {
      key: 'b',
      label: 'Problem',
      position: 2,
      covered: true,
      questionKeys: ['q2', 'shared'],
      dataSlotKeys: ['s2', 'shared'],
    },
  ];

  it('gives a key claimed by two sections to the first, so the order stays stable', () => {
    expect(headingByQuestionKey(chapters).get('shared')).toBe('Context');
    expect(headingByDataSlotKey(chapters).get('shared')).toBe('Context');
  });

  it('orders the headings by chapter, with the catch-all last', () => {
    expect(chapterHeadingOrder(chapters)).toEqual(['Context', 'Problem', UNCHAPTERED_HEADING]);
  });

  it('collapses two chapters that share a label into one heading', () => {
    const order = chapterHeadingOrder([chapters[0], { ...chapters[1], label: 'Context' }]);
    expect(order).toEqual(['Context', UNCHAPTERED_HEADING]);
  });
});

describe('chapterDataSlotGroups', () => {
  const chapters: ReportChapter[] = [
    {
      key: 'a',
      label: 'Context',
      position: 1,
      covered: true,
      questionKeys: [],
      dataSlotKeys: ['s1'],
    },
    {
      key: 'b',
      label: 'Problem',
      position: 2,
      covered: true,
      questionKeys: [],
      dataSlotKeys: ['s2'],
    },
  ];
  const slot = (key: string) => ({ key, name: key, description: null, value: 'x' });

  it('re-buckets themed groups into chapter order, ignoring the authored theme', () => {
    const grouped = chapterDataSlotGroups(
      // Authored under one theme; the respondent met the two slots in different parts.
      [{ theme: 'Everything', slots: [slot('s2'), slot('s1')] }],
      chapters
    );
    expect(grouped.map((g) => [g.theme, g.slots.map((s) => s.key)])).toEqual([
      ['Context', ['s1']],
      ['Problem', ['s2']],
    ]);
  });

  it('keeps a slot belonging to no chapter under the catch-all rather than dropping it', () => {
    const grouped = chapterDataSlotGroups([{ theme: 'T', slots: [slot('orphan')] }], chapters);
    expect(grouped).toEqual([{ theme: UNCHAPTERED_HEADING, slots: [slot('orphan')] }]);
  });

  it('drops a chapter that ended up with nothing in it', () => {
    const grouped = chapterDataSlotGroups([{ theme: 'T', slots: [slot('s1')] }], chapters);
    expect(grouped.map((g) => g.theme)).toEqual(['Context']);
  });

  it('returns nothing for an absent group list', () => {
    expect(chapterDataSlotGroups(null, chapters)).toEqual([]);
  });

  it('leaves the authored themes alone when no chapter knows anything about the slots', () => {
    // Every `document`-sourced section set is this shape: `fromDocument` groups questions only and
    // always writes `dataSlotKeys: []`. Re-bucketing against it would sweep every slot into the
    // catch-all and throw the authored theme names away for nothing.
    const questionsOnly = chapters.map((c) => ({ ...c, dataSlotKeys: [] }));
    const authored = [
      { theme: 'Commercials', slots: [slot('s1')] },
      { theme: 'Delivery', slots: [slot('s2')] },
    ];
    expect(chapterDataSlotGroups(authored, questionsOnly)).toEqual(authored);
  });

  it('still returns nothing for an absent group list when no chapter has slot membership', () => {
    expect(
      chapterDataSlotGroups(
        null,
        chapters.map((c) => ({ ...c, dataSlotKeys: [] }))
      )
    ).toEqual([]);
  });
});
