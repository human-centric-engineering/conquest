import { describe, it, expect } from 'vitest';

import {
  inheritTopicForQuestion,
  planDataSlotAttachment,
  planSeededTopics,
} from '@/lib/app/questionnaire/scope/seed';

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

/**
 * `planDataSlotAttachment` — the rule that gives an orphaned data slot a home.
 *
 * It exists because topics are seeded during INGEST, which creates no data slots: those are
 * generated afterwards. Without a pass that runs when slots are written, every seeded topic keeps
 * `dataSlotKeys: []` forever and the two halves of the instrument never meet.
 *
 * The two properties worth defending are that it is ADDITIVE (it can never overrule or relocate an
 * admin's own placement) and DETERMINISTIC (the same inputs always attach the same way, whatever
 * order the caller happened to read rows in).
 */
describe('planDataSlotAttachment', () => {
  const topics = [
    { key: 'opening', ordinal: 0, members: { questionKeys: ['q_a'], dataSlotKeys: [] } },
    { key: 'growth', ordinal: 1, members: { questionKeys: ['q_b', 'q_c'], dataSlotKeys: [] } },
    { key: 'talent', ordinal: 2, members: { questionKeys: ['q_d'], dataSlotKeys: [] } },
  ];

  it('puts a slot in the topic owning most of its mapped questions', () => {
    const additions = planDataSlotAttachment({
      topics,
      // Two questions in `growth`, one in `opening` — the majority wins.
      dataSlots: [{ key: 'ambition', mappedQuestionKeys: ['q_a', 'q_b', 'q_c'] }],
    });

    expect(additions.get('growth')).toEqual(['ambition']);
    expect(additions.has('opening')).toBe(false);
  });

  it('breaks a tie toward the lower ordinal, not toward read order', () => {
    const additions = planDataSlotAttachment({
      // Reversed on the way in: a correct implementation ignores array order entirely.
      topics: [...topics].reverse(),
      dataSlots: [{ key: 'spanning', mappedQuestionKeys: ['q_a', 'q_d'] }],
    });

    expect(additions.get('opening')).toEqual(['spanning']);
  });

  it('never moves a slot that already belongs to a topic', () => {
    // The admin put `ambition` in `talent`, where the majority rule would not have. That decision
    // stands: an attach pass that second-guessed it would silently undo authoring on every save.
    const additions = planDataSlotAttachment({
      topics: [
        topics[0],
        topics[1],
        { ...topics[2], members: { questionKeys: ['q_d'], dataSlotKeys: ['ambition'] } },
      ],
      dataSlots: [{ key: 'ambition', mappedQuestionKeys: ['q_a', 'q_b', 'q_c'] }],
    });

    expect(additions.size).toBe(0);
  });

  it('skips a slot whose questions no topic claims', () => {
    // No defensible home — the orphan findings report it where an admin can fix it.
    const additions = planDataSlotAttachment({
      topics,
      dataSlots: [{ key: 'stray', mappedQuestionKeys: ['q_gone'] }],
    });

    expect(additions.size).toBe(0);
  });

  it('is idempotent — a second pass over its own result attaches nothing', () => {
    const first = planDataSlotAttachment({
      topics,
      dataSlots: [{ key: 'ambition', mappedQuestionKeys: ['q_b'] }],
    });
    const applied = topics.map((t) => ({
      ...t,
      members: {
        ...t.members,
        dataSlotKeys: [...t.members.dataSlotKeys, ...(first.get(t.key) ?? [])],
      },
    }));

    const second = planDataSlotAttachment({
      topics: applied,
      dataSlots: [{ key: 'ambition', mappedQuestionKeys: ['q_b'] }],
    });

    expect(first.get('growth')).toEqual(['ambition']);
    expect(second.size).toBe(0);
  });

  it('attaches several slots to the same topic, in slot order', () => {
    const additions = planDataSlotAttachment({
      topics,
      dataSlots: [
        { key: 'pace', mappedQuestionKeys: ['q_b'] },
        { key: 'blockers', mappedQuestionKeys: ['q_c'] },
      ],
    });

    expect(additions.get('growth')).toEqual(['pace', 'blockers']);
  });

  it('returns nothing when there are no topics or no slots', () => {
    expect(
      planDataSlotAttachment({ topics: [], dataSlots: [{ key: 'a', mappedQuestionKeys: ['q_a'] }] })
        .size
    ).toBe(0);
    expect(planDataSlotAttachment({ topics, dataSlots: [] }).size).toBe(0);
  });
});

/**
 * `inheritTopicForQuestion` (F17.35).
 *
 * The rule has to match `planDataSlotAttachment`'s exactly — same majority, same tie-break — or
 * "which topic does this belong to" quietly has two answers. The tie case is asserted explicitly
 * for that reason, and because bailing on it would orphan the most ordinary shape there is: a
 * section split across two topics.
 */
describe('inheritTopicForQuestion', () => {
  const topics = [
    { key: 'growth', ordinal: 0, members: { questionKeys: ['g1', 'g2'], dataSlotKeys: [] } },
    { key: 'pipeline', ordinal: 1, members: { questionKeys: ['p1'], dataSlotKeys: [] } },
  ];

  it('picks the topic owning most of the siblings', () => {
    expect(inheritTopicForQuestion(topics, ['g1', 'g2', 'p1'])).toBe('growth');
  });

  it('picks the only owner when the siblings sit in one topic', () => {
    expect(inheritTopicForQuestion(topics, ['p1'])).toBe('pipeline');
  });

  it('breaks a tie to the LOWER ordinal, matching planDataSlotAttachment', () => {
    // 1–1. A section split across two topics ties like this constantly, so this is the ordinary
    // case: bailing here would orphan exactly the questions this function exists to place.
    expect(inheritTopicForQuestion(topics, ['g1', 'p1'])).toBe('growth');
  });

  it('agrees with planDataSlotAttachment on the same tie', () => {
    // The two rules are one rule. If this ever diverges, one of them was edited alone.
    const viaSlots = planDataSlotAttachment({
      topics,
      dataSlots: [{ key: 'slot', mappedQuestionKeys: ['g1', 'p1'] }],
    });
    expect([...viaSlots.keys()]).toEqual([inheritTopicForQuestion(topics, ['g1', 'p1'])]);
  });

  it('ignores ordinal when the majority is clear', () => {
    // `pipeline` has the HIGHER ordinal and still wins, 2 members to 1 — which is the only way to
    // show that ordinal is the tie-break and not the ranking. (An earlier version of this test also
    // asserted `['g1','p1','p1'] → growth` under the same name; that is a 1–1 tie resolved by
    // ordinal, so it proved the opposite of what it claimed and duplicated the tie-break test above.)
    expect(
      inheritTopicForQuestion(
        [
          { key: 'growth', ordinal: 0, members: { questionKeys: ['g1'], dataSlotKeys: [] } },
          {
            key: 'pipeline',
            ordinal: 1,
            members: { questionKeys: ['p1', 'p2'], dataSlotKeys: [] },
          },
        ],
        ['g1', 'p1', 'p2']
      )
    ).toBe('pipeline');
  });

  it('counts each topic member once, however often a sibling key is repeated', () => {
    // Weight comes from how many of a TOPIC's members appear among the siblings, not from how many
    // times a sibling key was listed — so a caller passing duplicates cannot tip the majority.
    expect(inheritTopicForQuestion(topics, ['g1', 'p1', 'p1', 'p1'])).toBe(
      inheritTopicForQuestion(topics, ['g1', 'p1'])
    );
  });

  it('returns null when no topic owns any sibling — the undecidable case', () => {
    expect(inheritTopicForQuestion(topics, ['unknown_1', 'unknown_2'])).toBeNull();
  });

  it('returns null with no topics and with no siblings', () => {
    expect(inheritTopicForQuestion([], ['g1'])).toBeNull();
    expect(inheritTopicForQuestion(topics, [])).toBeNull();
  });

  it('does not mutate the topics it was given', () => {
    const input = structuredClone(topics);
    inheritTopicForQuestion(input, ['g1', 'p1']);
    expect(input).toEqual(topics);
  });
});
