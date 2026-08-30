/**
 * Integration test: the design-evaluation structure loader (F5.1).
 *
 * `buildEvaluationStructure` is the read-side DB seam — it maps a version's persisted
 * graph (goal, audience, sections → slots) into the pure `VersionStructureInput` the
 * judges read. Prisma is mocked (house convention). The evaluate-preview route test
 * exercises the common path; this pins the branches the route body can't reach
 * (present vs absent guidelines/description, a null goal, a malformed stored audience)
 * plus the not-found failure mode, so the loader's branches are covered without routing
 * through HTTP.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';

type Mock = ReturnType<typeof vi.fn>;

/** A version row with one fully-populated question and one section description. */
function richVersionRow() {
  return {
    goal: 'Understand onboarding friction.',
    audience: { role: 'Engineer', expertiseLevel: 'intermediate' },
    sections: [
      {
        title: 'Background',
        description: 'A little about you.',
        questions: [
          {
            key: 'q_role',
            prompt: 'What is your role?',
            type: 'free_text',
            required: true,
            guidelines: 'Be specific.',
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildEvaluationStructure', () => {
  it('maps the full graph, including guidelines + section description', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(richVersionRow());

    const structure = await buildEvaluationStructure('qn-1', 'v1');

    expect(structure).not.toBeNull();
    expect(structure?.goal).toBe('Understand onboarding friction.');
    expect(structure?.audience?.role).toBe('Engineer');
    expect(structure?.sections).toHaveLength(1);
    expect(structure?.sections[0].description).toBe('A little about you.');
    expect(structure?.sections[0].questions[0].guidelines).toBe('Be specific.');
    expect(structure?.sections[0].questions[0].required).toBe(true);
  });

  it('omits guidelines and description when absent (conditional spread branches)', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue({
      goal: 'g',
      audience: null,
      sections: [
        {
          title: 'S',
          description: null,
          questions: [
            { key: 'q1', prompt: 'p', type: 'free_text', required: false, guidelines: null },
          ],
        },
      ],
    });

    const structure = await buildEvaluationStructure('qn-1', 'v1');

    expect(structure?.sections[0]).not.toHaveProperty('description');
    expect(structure?.sections[0].questions[0]).not.toHaveProperty('guidelines');
  });

  it('normalises a null goal to null', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [],
    });

    const structure = await buildEvaluationStructure('qn-1', 'v1');
    expect(structure?.goal).toBeNull();
  });

  it('degrades a malformed stored audience to null rather than throwing', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue({
      goal: 'g',
      audience: { expertiseLevel: 'guru' }, // not a valid enum
      sections: [],
    });

    const structure = await buildEvaluationStructure('qn-1', 'v1');
    expect(structure?.audience).toBeNull();
  });

  it('returns null when the version does not resolve under the questionnaire', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);
    expect(await buildEvaluationStructure('qn-1', 'bad-vid')).toBeNull();
  });
});

/**
 * The Conditional Topics overlay (F17.34).
 *
 * The judges read a flat list of questions, which is why the Duplicates judge was proposing to
 * delete a depth probe as a duplicate of the broad opening question the planner seated it *because
 * of*. The overlay is what gives it the evidence to tell those apart.
 *
 * The first test here is the one that matters most: routing off must produce exactly the DTO it
 * produced before this existed, because that is what makes the prompt for the majority of
 * questionnaires byte-identical to what it was.
 */
describe('buildEvaluationStructure — routing overlay', () => {
  function versionRow(over: Record<string, unknown> = {}) {
    return {
      goal: 'g',
      audience: null,
      config: { conditionalTopics: { enabled: true, maxConditionalTopics: 3 } },
      topics: [
        {
          key: 'opening',
          label: 'Opening',
          phase: 'opening',
          depth: 'full',
          members: { questionKeys: ['q1'], dataSlotKeys: [] },
        },
        {
          key: 'depth',
          label: 'Talent depth',
          phase: 'conditional',
          depth: 'light',
          members: { questionKeys: ['q2'], dataSlotKeys: [] },
        },
      ],
      sections: [
        {
          title: 'S',
          description: null,
          questions: [
            { key: 'q1', prompt: 'Broad?', type: 'free_text', required: true, guidelines: null },
            { key: 'q2', prompt: 'Deep?', type: 'free_text', required: false, guidelines: null },
            { key: 'q3', prompt: 'Loose?', type: 'free_text', required: false, guidelines: null },
          ],
        },
      ],
      ...over,
    };
  }

  it('omits routing and every topicKeys field when Conditional Topics is off', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(
      versionRow({ config: { conditionalTopics: { enabled: false } } })
    );

    const structure = await buildEvaluationStructure('qn-1', 'v1');

    expect(structure).not.toHaveProperty('routing');
    for (const q of structure!.sections[0].questions) {
      expect(q).not.toHaveProperty('topicKeys');
    }
  });

  it('omits routing when the version has no config row at all', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(
      versionRow({ config: null })
    );

    expect(await buildEvaluationStructure('qn-1', 'v1')).not.toHaveProperty('routing');
  });

  it('carries the topic roster and the conditional-question count when on', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(versionRow());

    const structure = await buildEvaluationStructure('qn-1', 'v1');

    expect(structure?.routing).toEqual({
      enabled: true,
      maxConditionalTopics: 3,
      topics: [
        { key: 'opening', label: 'Opening', phase: 'opening', depth: 'full', questionCount: 1 },
        {
          key: 'depth',
          label: 'Talent depth',
          phase: 'conditional',
          depth: 'light',
          questionCount: 1,
        },
      ],
      conditionalQuestionCount: 1,
    });
  });

  it('tags each question with the topics that claim it', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(versionRow());

    const [q1, q2] = (await buildEvaluationStructure('qn-1', 'v1'))!.sections[0].questions;

    expect(q1.topicKeys).toEqual(['opening']);
    expect(q2.topicKeys).toEqual(['depth']);
  });

  it('gives an uncovered question an EMPTY array, not an absent field', async () => {
    // Absent means "routing is off"; empty means "routing is on and nothing claims this, so it can
    // never be asked". A judge must not read the second as unremarkable.
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(versionRow());

    const q3 = (await buildEvaluationStructure('qn-1', 'v1'))!.sections[0].questions[2];

    expect(q3.topicKeys).toEqual([]);
  });

  it('keeps every topic a multi-membership question belongs to', async () => {
    // Legal, and reported as a `duplicate_membership` warning rather than prevented. Collapsing to
    // one owner would let a question that is in a `core` topic — and so asked of everyone — be
    // labelled conditional.
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(
      versionRow({
        topics: [
          {
            key: 'core_spine',
            label: 'Spine',
            phase: 'core',
            depth: 'full',
            members: { questionKeys: ['q1'], dataSlotKeys: [] },
          },
          {
            key: 'depth',
            label: 'Depth',
            phase: 'conditional',
            depth: 'full',
            members: { questionKeys: ['q1'], dataSlotKeys: [] },
          },
        ],
      })
    );

    const structure = await buildEvaluationStructure('qn-1', 'v1');

    expect(structure!.sections[0].questions[0].topicKeys).toEqual(['core_spine', 'depth']);
  });

  it('ignores member keys that no longer resolve to a question', async () => {
    // An author deleting a question leaves the key behind. Counting it would make a topic read as
    // larger than it asks, and "deleting this guts the topic" is a judgement made on that number.
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(
      versionRow({
        topics: [
          {
            key: 'opening',
            label: 'Opening',
            phase: 'opening',
            depth: 'full',
            members: { questionKeys: ['q1', 'q_long_deleted'], dataSlotKeys: [] },
          },
        ],
      })
    );

    const structure = await buildEvaluationStructure('qn-1', 'v1');

    expect(structure?.routing?.topics[0].questionCount).toBe(1);
  });

  it('degrades a malformed conditionalTopics blob to "off" rather than throwing', async () => {
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(
      versionRow({ config: { conditionalTopics: 'not an object' } })
    );

    expect(await buildEvaluationStructure('qn-1', 'v1')).not.toHaveProperty('routing');
  });
});
