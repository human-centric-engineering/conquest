/**
 * Unit tests for loadIntroGenerationContext (F12.2).
 *
 * Verifies the goal + question prompts are formatted (and scoped to the version pair), and that the
 * empty / missing cases return null so the route falls back to a brief-only generate.
 *
 * @see app/api/v1/app/questionnaires/intro-background/_lib/generation-context.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireVersion: { findFirst: vi.fn() } },
}));

import { loadIntroGenerationContext } from '@/app/api/v1/app/questionnaires/intro-background/_lib/generation-context';
import { prisma } from '@/lib/db/client';

type Mock = ReturnType<typeof vi.fn>;
const findFirst = prisma.appQuestionnaireVersion.findFirst as unknown as Mock;

/** Build a version row with the given goal and a flat list of question prompts (one section). */
function versionRow(goal: string | null, prompts: string[]) {
  return { goal, sections: [{ questions: prompts.map((prompt) => ({ prompt })) }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadIntroGenerationContext', () => {
  it('scopes the query to both the questionnaire and the version id', async () => {
    findFirst.mockResolvedValue(
      versionRow('Understand collaboration', ['How do you collaborate?'])
    );
    await loadIntroGenerationContext('q-1', 'v-1');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v-1', questionnaireId: 'q-1' } })
    );
  });

  it('returns null when the version is absent (mismatched pair)', async () => {
    findFirst.mockResolvedValue(null);
    expect(await loadIntroGenerationContext('q-1', 'v-x')).toBeNull();
  });

  it('returns null when there is neither a goal nor any questions', async () => {
    findFirst.mockResolvedValue(versionRow('   ', []));
    expect(await loadIntroGenerationContext('q-1', 'v-1')).toBeNull();
  });

  it('formats the goal and question prompts', async () => {
    findFirst.mockResolvedValue(
      versionRow('Understand team collaboration', ['How often do you pair?', 'What blocks you?'])
    );
    const context = await loadIntroGenerationContext('q-1', 'v-1');
    expect(context).toContain('Understand team collaboration');
    expect(context).toContain('- How often do you pair?');
    expect(context).toContain('- What blocks you?');
  });

  it('includes the goal even when the version has no questions', async () => {
    findFirst.mockResolvedValue(versionRow('Just the goal', []));
    const context = await loadIntroGenerationContext('q-1', 'v-1');
    expect(context).toContain('Just the goal');
    expect(context).not.toContain('Questions it asks');
  });

  it('caps the question list and notes how many more were dropped', async () => {
    const prompts = Array.from({ length: 85 }, (_, i) => `Question ${i + 1}`);
    findFirst.mockResolvedValue(versionRow('Goal', prompts));
    const context = await loadIntroGenerationContext('q-1', 'v-1');
    expect(context).toContain('- Question 80');
    expect(context).not.toContain('- Question 81');
    expect(context).toContain('and 5 more');
  });
});
