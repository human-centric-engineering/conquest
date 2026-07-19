import { describe, expect, it } from 'vitest';

import { resolveFindingTarget } from '@/app/api/v1/app/questionnaires/_lib/evaluation-target';
import type { VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

/** A two-section structure so section membership and position both have something to prove. */
function structure(overrides?: Partial<VersionStructureInput>): VersionStructureInput {
  return {
    goal: 'Understand onboarding friction',
    audience: { expertiseLevel: 'intermediate', role: 'new hire' },
    sections: [
      {
        title: 'Background',
        questions: [
          { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
          { key: 'q_team', prompt: 'Which team?', type: 'single_choice', required: false },
        ],
      },
      {
        title: 'Experience',
        questions: [
          {
            key: 'q_ramp',
            prompt: 'How long did ramp-up take?',
            type: 'free_text',
            required: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('resolveFindingTarget — questions', () => {
  it('names the question, its section, and its 1-based position', () => {
    const target = resolveFindingTarget('q_team', structure(), structure());
    expect(target).toEqual({
      kind: 'question',
      key: 'q_team',
      label: 'Which team?',
      sectionTitle: 'Background',
      position: 2,
      sectionPosition: 1,
      questionType: 'single_choice',
      removed: false,
    });
  });

  it('reports the containing section’s 1-based index, so questions order across sections', () => {
    // `position` alone cannot order these two: both are the 1st/2nd of their own section.
    const first = resolveFindingTarget('q_role', structure(), structure());
    const later = resolveFindingTarget('q_ramp', structure(), structure());
    expect(first).toMatchObject({ sectionPosition: 1, position: 1 });
    expect(later).toMatchObject({ sectionPosition: 2, position: 1 });
  });

  it('resolves against the live structure, not the run snapshot, when the prompt was reworded', () => {
    const snapshot = structure();
    const current = structure({
      sections: [
        {
          title: 'Background',
          questions: [
            { key: 'q_role', prompt: 'What is your job title?', type: 'free_text', required: true },
          ],
        },
      ],
    });
    const target = resolveFindingTarget('q_role', current, snapshot);
    expect(target?.label).toBe('What is your job title?');
    expect(target?.removed).toBe(false);
  });

  it('falls back to the snapshot and flags removed when the question is gone from the live structure', () => {
    const current = structure({
      sections: [{ title: 'Background', questions: [] }],
    });
    const target = resolveFindingTarget('q_role', current, structure());
    expect(target).toMatchObject({
      kind: 'question',
      label: 'What is your role?',
      sectionTitle: 'Background',
      removed: true,
    });
  });

  it('reports the position within the question’s own section, not the whole structure', () => {
    const target = resolveFindingTarget('q_ramp', structure(), structure());
    expect(target).toMatchObject({ sectionTitle: 'Experience', position: 1 });
  });
});

describe('resolveFindingTarget — non-question targets', () => {
  it('labels the version-level goal and audience', () => {
    expect(resolveFindingTarget('goal', structure(), null)).toMatchObject({
      kind: 'goal',
      label: 'Questionnaire goal',
    });
    expect(resolveFindingTarget('audience', structure(), null)).toMatchObject({
      kind: 'audience',
      label: 'Target audience',
    });
  });

  it('strips the section: prefix and keeps the title as the label', () => {
    expect(resolveFindingTarget('section:Background', structure(), null)).toMatchObject({
      kind: 'section',
      label: 'Background',
      sectionPosition: 1,
      removed: false,
    });
    expect(resolveFindingTarget('section:Experience', structure(), null)).toMatchObject({
      sectionPosition: 2,
    });
  });

  it('leaves the version-level targets unpositioned', () => {
    expect(resolveFindingTarget('goal', structure(), null)).toMatchObject({
      sectionPosition: null,
      position: null,
    });
  });

  it('flags a section whose title no longer exists live', () => {
    const current = structure({ sections: [{ title: 'Renamed', questions: [] }] });
    expect(resolveFindingTarget('section:Background', current, structure())).toMatchObject({
      kind: 'section',
      label: 'Background',
      removed: true,
    });
  });
});

describe('resolveFindingTarget — degradation', () => {
  it('degrades an unresolvable key to kind unknown rather than throwing', () => {
    const target = resolveFindingTarget('q_invented_by_the_judge', structure(), structure());
    expect(target).toMatchObject({
      kind: 'unknown',
      key: 'q_invented_by_the_judge',
      label: 'q_invented_by_the_judge',
    });
  });

  it('returns null when there is no structure at all to resolve against', () => {
    expect(resolveFindingTarget('q_role', null, null)).toBeNull();
  });

  it('resolves from the snapshot alone when the live structure failed to load', () => {
    expect(resolveFindingTarget('q_role', null, structure())).toMatchObject({
      kind: 'question',
      label: 'What is your role?',
      removed: true,
    });
  });
});
