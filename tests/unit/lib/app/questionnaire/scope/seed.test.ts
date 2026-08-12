import { describe, it, expect } from 'vitest';

import { planSeededTopics } from '@/lib/app/questionnaire/scope/seed';

const sections = [
  { id: 's1', title: 'Growth Strategy', ordinal: 0 },
  { id: 's2', title: 'Pipeline Management', ordinal: 1 },
];
const questions = [
  { key: 'growth_strategy', sectionId: 's1' },
  { key: 'pipeline_1', sectionId: 's2' },
  { key: 'pipeline_2', sectionId: 's2' },
];

describe('planSeededTopics', () => {
  it('seeds one always-asked topic per section', () => {
    const topics = planSeededTopics({ sections, questions });

    expect(topics).toHaveLength(2);
    // The load-bearing default: seeding is preparation, not activation, so every seeded topic runs.
    expect(topics.every((t) => t.phase === 'core')).toBe(true);
    expect(topics.every((t) => t.source === 'seeded')).toBe(true);
  });

  it('gives each topic its section’s questions, in order', () => {
    const topics = planSeededTopics({ sections, questions });

    expect(topics[0]?.members.questionKeys).toEqual(['growth_strategy']);
    expect(topics[1]?.members.questionKeys).toEqual(['pipeline_1', 'pipeline_2']);
  });

  it('derives a readable key from the section title and keeps the title as the label', () => {
    const topics = planSeededTopics({ sections, questions });

    expect(topics[0]?.key).toBe('growth_strategy');
    expect(topics[0]?.label).toBe('Growth Strategy');
  });

  it('follows section ordinal, not array order', () => {
    const topics = planSeededTopics({
      sections: [
        { id: 's2', title: 'Second', ordinal: 5 },
        { id: 's1', title: 'First', ordinal: 1 },
      ],
      questions: [
        { key: 'b', sectionId: 's2' },
        { key: 'a', sectionId: 's1' },
      ],
    });

    expect(topics.map((t) => t.label)).toEqual(['First', 'Second']);
    expect(topics.map((t) => t.ordinal)).toEqual([0, 1]);
  });

  it('skips a section with no questions', () => {
    // An empty topic is noise on the authoring surface and can never be chosen.
    const topics = planSeededTopics({
      sections: [...sections, { id: 's3', title: 'Empty', ordinal: 2 }],
      questions,
    });

    expect(topics.map((t) => t.label)).toEqual(['Growth Strategy', 'Pipeline Management']);
  });

  it('does not collide with keys already taken', () => {
    const topics = planSeededTopics({
      sections,
      questions,
      existingKeys: new Set(['growth_strategy']),
    });

    expect(topics[0]?.key).toBe('growth_strategy_2');
  });

  it('falls back to a usable key when the title slugifies to nothing', () => {
    const topics = planSeededTopics({
      sections: [{ id: 's1', title: '???', ordinal: 0 }],
      questions: [{ key: 'q', sectionId: 's1' }],
    });

    expect(topics[0]?.key).toBeTruthy();
    // Label falls back to the key rather than rendering an empty heading.
    expect(topics[0]?.label).toBe('???');
  });

  describe('data-slot attribution', () => {
    it('puts a slot in the topic owning most of its mapped questions', () => {
      const topics = planSeededTopics({
        sections,
        questions,
        dataSlots: [{ key: 'pipeline_health', mappedQuestionKeys: ['pipeline_1', 'pipeline_2'] }],
      });

      expect(topics[0]?.members.dataSlotKeys).toEqual([]);
      expect(topics[1]?.members.dataSlotKeys).toEqual(['pipeline_health']);
    });

    it('breaks a tie toward the earlier section, deterministically', () => {
      // A slot spanning a section boundary has to belong somewhere; the earlier section wins so
      // repeated seeds of the same graph produce identical topics.
      const topics = planSeededTopics({
        sections,
        questions,
        dataSlots: [{ key: 'spans', mappedQuestionKeys: ['growth_strategy', 'pipeline_1'] }],
      });

      expect(topics[0]?.members.dataSlotKeys).toEqual(['spans']);
      expect(topics[1]?.members.dataSlotKeys).toEqual([]);
    });

    it('drops a slot whose questions all belong to skipped sections', () => {
      const topics = planSeededTopics({
        sections,
        questions,
        dataSlots: [{ key: 'orphan', mappedQuestionKeys: ['not_a_real_key'] }],
      });

      expect(topics.flatMap((t) => t.members.dataSlotKeys)).toEqual([]);
    });

    it('never lists the same slot twice', () => {
      const topics = planSeededTopics({
        sections,
        questions,
        dataSlots: [
          { key: 'dupe', mappedQuestionKeys: ['pipeline_1'] },
          { key: 'dupe', mappedQuestionKeys: ['pipeline_2'] },
        ],
      });

      expect(topics[1]?.members.dataSlotKeys).toEqual(['dupe']);
    });
  });

  it('seeds nothing for a version with no sections', () => {
    expect(planSeededTopics({ sections: [], questions: [] })).toEqual([]);
  });
});
