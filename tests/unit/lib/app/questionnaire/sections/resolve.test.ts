/**
 * `resolveInterviewSections` / `resolveSectionSource` — the ladder, the ordering, and the two ways
 * an interview comes back unsectioned.
 *
 * The load-bearing assertions here are the negative ones. A version that resolves to fewer than two
 * sections, or has the feature off, must return `[]`, because every caller reads the empty list as
 * "run exactly as before" and none of them checks the length itself.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveInterviewSections,
  resolveSectionSource,
  sectionByDataSlotKey,
  sectionByQuestionKey,
  type SectionResolverInput,
} from '@/lib/app/questionnaire/sections/resolve';
import { DEFAULT_SECTIONED_INTERVIEW_SETTINGS } from '@/lib/app/questionnaire/sections/settings';
import type { Topic, TopicPhase } from '@/lib/app/questionnaire/scope/types';

function topic(
  key: string,
  ordinal: number,
  questionKeys: string[],
  dataSlotKeys: string[] = [],
  phase: TopicPhase = 'core'
): Topic {
  return {
    id: `t_${key}`,
    key,
    label: key.replace(/_/g, ' '),
    description: null,
    phase,
    criteria: null,
    depth: 'full',
    members: { questionKeys, dataSlotKeys },
    ordinal,
    source: 'seeded',
    trigger: null,
  };
}

function input(overrides: Partial<SectionResolverInput> = {}): SectionResolverInput {
  return {
    settings: { ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS, enabled: true },
    topics: [],
    conditionalTopicsEnabled: false,
    dataSlots: [],
    documentSections: [],
    questions: [],
    ...overrides,
  };
}

const TWO_TOPICS = [topic('context', 0, ['q1']), topic('appetite', 1, ['q2'])];

describe('resolveSectionSource — the ladder', () => {
  it('prefers topics when conditional topics is on and topics exist', () => {
    expect(
      resolveSectionSource(input({ topics: TWO_TOPICS, conditionalTopicsEnabled: true }))
    ).toBe('topics');
  });

  it('does not use topics when conditional topics is off, even though the rows exist', () => {
    // Topics are seeded on every ingest, so "there are topics" says nothing about whether the
    // author has adopted them. The switch is what makes them live.
    expect(
      resolveSectionSource(
        input({
          topics: TWO_TOPICS,
          conditionalTopicsEnabled: false,
          dataSlots: [{ key: 's1', theme: 'Pipeline', ordinal: 0 }],
        })
      )
    ).toBe('themes');
  });

  it('falls to document sections when nothing else can supply a grouping', () => {
    expect(
      resolveSectionSource(
        input({
          documentSections: [{ id: 'sec1', title: 'Background', ordinal: 0 }],
          questions: [{ key: 'q1', sectionId: 'sec1' }],
        })
      )
    ).toBe('document');
  });

  it('returns null when no grouping can supply anything', () => {
    expect(resolveSectionSource(input())).toBeNull();
  });

  it('honours an explicit pin', () => {
    expect(
      resolveSectionSource(
        input({
          settings: { ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS, enabled: true, source: 'document' },
          topics: TWO_TOPICS,
          conditionalTopicsEnabled: true,
          documentSections: [{ id: 'sec1', title: 'Background', ordinal: 0 }],
          questions: [{ key: 'q1', sectionId: 'sec1' }],
        })
      )
    ).toBe('document');
  });

  it('falls through the ladder when the pinned grouping cannot supply sections', () => {
    // An author who pinned `topics` and later switched Conditional Topics off should still get a
    // working sectioned interview, not an unsectioned one that ignores the rest of their settings.
    expect(
      resolveSectionSource(
        input({
          settings: { ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS, enabled: true, source: 'topics' },
          topics: TWO_TOPICS,
          conditionalTopicsEnabled: false,
          dataSlots: [{ key: 's1', theme: 'Pipeline', ordinal: 0 }],
        })
      )
    ).toBe('themes');
  });
});

describe('resolveInterviewSections — the inert guarantee', () => {
  it('returns nothing when the feature is off, whatever else is available', () => {
    expect(
      resolveInterviewSections(
        input({
          settings: DEFAULT_SECTIONED_INTERVIEW_SETTINGS,
          topics: TWO_TOPICS,
          conditionalTopicsEnabled: true,
        })
      )
    ).toEqual([]);
  });

  it('returns nothing when only one section resolves', () => {
    // One section is not a sectioned interview: it is the whole questionnaire with a tab strip and
    // a "move on" control that goes nowhere.
    const sections = resolveInterviewSections(
      input({ topics: [topic('only', 0, ['q1'])], conditionalTopicsEnabled: true })
    );
    expect(sections).toEqual([]);
  });

  it('returns nothing when no grouping supplies anything', () => {
    expect(resolveInterviewSections(input())).toEqual([]);
  });
});

describe('resolveInterviewSections — topics', () => {
  it('hoists the opening and pins the closing, whatever the ordinals say', () => {
    const sections = resolveInterviewSections(
      input({
        conditionalTopicsEnabled: true,
        topics: [
          topic('wrap', 0, ['q4'], [], 'closing'),
          topic('middle', 1, ['q2']),
          topic('warmup', 9, ['q1'], [], 'opening'),
          topic('other', 2, ['q3'], [], 'conditional'),
        ],
      })
    );
    expect(sections.map((s) => s.key)).toEqual(['warmup', 'middle', 'other', 'wrap']);
    expect(sections.map((s) => s.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('carries both kinds of membership, which is why topics are the preferred source', () => {
    const sections = resolveInterviewSections(
      input({
        conditionalTopicsEnabled: true,
        topics: [topic('a', 0, ['q1'], ['s1']), topic('b', 1, ['q2'], ['s2'])],
      })
    );
    expect(sections[0]).toMatchObject({
      key: 'a',
      source: 'topics',
      questionKeys: ['q1'],
      dataSlotKeys: ['s1'],
    });
  });
});

describe('resolveInterviewSections — themes', () => {
  const dataSlots = [
    { key: 'growth', theme: 'Commercial', ordinal: 5 },
    { key: 'team', theme: 'People', ordinal: 1 },
    { key: 'pricing', theme: 'Commercial', ordinal: 2 },
    { key: 'unthemed', theme: '  ', ordinal: 0 },
  ];

  it('orders themes by their earliest slot, not by first appearance', () => {
    const sections = resolveInterviewSections(input({ dataSlots }));
    // People's earliest slot is ordinal 1; Commercial's is 2. Commercial appeared first in the list.
    expect(sections.map((s) => s.label)).toEqual(['People', 'Commercial']);
  });

  it('drops slots with no theme rather than inventing a catch-all section', () => {
    const sections = resolveInterviewSections(input({ dataSlots }));
    expect(sections.flatMap((s) => s.dataSlotKeys)).not.toContain('unthemed');
  });

  it('carries the questions its slots map to, so the close gate has something to measure', () => {
    const sections = resolveInterviewSections(
      input({ dataSlots }),
      new Map([
        ['pricing', ['q_price']],
        ['growth', ['q_growth', 'q_price']],
      ])
    );
    const commercial = sections.find((s) => s.label === 'Commercial');
    // Deduped: `q_price` is mapped by both slots in this theme.
    expect(commercial?.questionKeys).toEqual(['q_price', 'q_growth']);
  });

  it('slugifies theme keys and keeps two themes that slugify alike distinct', () => {
    const sections = resolveInterviewSections(
      input({
        dataSlots: [
          { key: 'a', theme: 'Go to market', ordinal: 0 },
          { key: 'b', theme: 'Go-to-market', ordinal: 1 },
        ],
      })
    );
    const keys = sections.map((s) => s.key);
    expect(new Set(keys).size).toBe(2);
    expect(sections.map((s) => s.label)).toEqual(['Go to market', 'Go-to-market']);
  });
});

describe('resolveInterviewSections — document sections', () => {
  it('drops a section with no questions and renumbers what is left', () => {
    const sections = resolveInterviewSections(
      input({
        documentSections: [
          { id: 'sec1', title: 'Background', ordinal: 0 },
          { id: 'empty', title: 'Nothing here', ordinal: 1 },
          { id: 'sec2', title: 'Appetite', ordinal: 2 },
        ],
        questions: [
          { key: 'q1', sectionId: 'sec1' },
          { key: 'q2', sectionId: 'sec2' },
        ],
      })
    );
    expect(sections.map((s) => s.key)).toEqual(['sec1', 'sec2']);
    expect(sections.map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it('carries no data slots, which is why it is the last rung', () => {
    const sections = resolveInterviewSections(
      input({
        documentSections: [
          { id: 'sec1', title: 'A', ordinal: 0 },
          { id: 'sec2', title: 'B', ordinal: 1 },
        ],
        questions: [
          { key: 'q1', sectionId: 'sec1' },
          { key: 'q2', sectionId: 'sec2' },
        ],
      })
    );
    expect(sections.every((s) => s.dataSlotKeys.length === 0)).toBe(true);
  });
});

describe('resolveInterviewSections — scope', () => {
  const scoped = (questionKeys: string[], dataSlotKeys: string[] = []) =>
    resolveInterviewSections(
      input({
        conditionalTopicsEnabled: true,
        topics: [
          topic('a', 0, ['q1', 'q2'], ['s1']),
          topic('b', 1, ['q3'], ['s2']),
          topic('c', 2, ['q4'], []),
        ],
        scope: {
          questionKeys: new Set(questionKeys),
          dataSlotKeys: new Set(dataSlotKeys),
        },
      })
    );

  it('narrows a section to the keys scope allowed', () => {
    const sections = scoped(['q1', 'q3'], ['s1', 's2']);
    expect(sections.find((s) => s.key === 'a')?.questionKeys).toEqual(['q1']);
  });

  it('drops a section scope emptied, and renumbers so "section N of M" stays honest', () => {
    const sections = scoped(['q1', 'q4']);
    expect(sections.map((s) => s.key)).toEqual(['a', 'c']);
    expect(sections.map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it('never reintroduces a key scope excluded', () => {
    const sections = scoped(['q1']);
    // Only topic `a` survives, so this falls below the two-section floor and comes back unsectioned
    // rather than as a one-tab interview.
    expect(sections).toEqual([]);
  });

  it('keeps a section whose only surviving membership is a data slot', () => {
    const sections = scoped(['q3'], ['s1', 's2']);
    expect(sections.map((s) => s.key)).toEqual(['a', 'b']);
    expect(sections[0]).toMatchObject({ questionKeys: [], dataSlotKeys: ['s1'] });
  });
});

describe('membership lookups', () => {
  const sections = resolveInterviewSections(
    input({
      conditionalTopicsEnabled: true,
      topics: [topic('a', 0, ['q1', 'shared'], ['s1']), topic('b', 1, ['shared', 'q2'], ['s2'])],
    })
  );

  it('maps each question to its section, first section winning an overlap', () => {
    const map = sectionByQuestionKey(sections);
    expect(map.get('q1')).toBe('a');
    expect(map.get('q2')).toBe('b');
    // Topic membership genuinely overlaps, and a question can only be worked through once.
    expect(map.get('shared')).toBe('a');
  });

  it('maps each data slot to its section', () => {
    const map = sectionByDataSlotKey(sections);
    expect(map.get('s1')).toBe('a');
    expect(map.get('s2')).toBe('b');
  });
});
