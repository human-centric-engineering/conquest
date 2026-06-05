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
