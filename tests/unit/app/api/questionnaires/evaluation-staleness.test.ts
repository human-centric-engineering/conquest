import { describe, expect, it } from 'vitest';

import {
  deriveApplicability,
  deriveFindingState,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-staleness';
import type { VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

/** A small two-question structure to diff against. */
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
    ],
    ...overrides,
  };
}

describe('deriveApplicability', () => {
  it('is manual with no op, deep-link for add_question, apply otherwise', () => {
    expect(deriveApplicability(null)).toBe('manual');
    expect(deriveApplicability({ op: 'add_question', prompt: 'New?', type: 'free_text' })).toBe(
      'deep-link'
    );
    expect(deriveApplicability({ op: 'replace_prompt', prompt: 'X' })).toBe('apply');
    expect(deriveApplicability({ op: 'delete_question' })).toBe('apply');
  });
});

describe('deriveFindingState — add_question', () => {
  it('is not stale when the named section still resolves uniquely', () => {
    const result = deriveFindingState(
      {
        targetKey: 'section:Background',
        op: {
          op: 'add_question',
          prompt: 'Team size?',
          type: 'free_text',
          sectionKey: 'Background',
        },
      },
      structure(),
      structure()
    );
    expect(result.stale).toBe(false);
    expect(result.applicable).toBe('deep-link');
  });

  it('is stale when the named section is gone', () => {
    const result = deriveFindingState(
      {
        targetKey: 'section:Background',
        op: {
          op: 'add_question',
          prompt: 'Team size?',
          type: 'free_text',
          sectionKey: 'Background',
        },
      },
      structure(),
      structure({ sections: [] })
    );
    expect(result.stale).toBe(true);
  });

  it('is NOT stale for a goal-targeted add even when the goal text changed', () => {
    const result = deriveFindingState(
      { targetKey: 'goal', op: { op: 'add_question', prompt: 'New?', type: 'free_text' } },
      structure(),
      structure({ goal: 'A completely rewritten goal' })
    );
    expect(result.stale).toBe(false);
  });
});

describe('deriveFindingState — slot targets', () => {
  it('is not stale when the targeted prompt is unchanged', () => {
    const snap = structure();
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'replace_prompt', prompt: 'Better role?' } },
      snap,
      structure()
    );
    expect(result.stale).toBe(false);
  });

  it('is stale when the targeted prompt changed since the run (replace_prompt)', () => {
    const current = structure();
    current.sections[0].questions[0].prompt = 'What is your job title?';
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'replace_prompt', prompt: 'X' } },
      structure(),
      current
    );
    expect(result.stale).toBe(true);
  });

  it('is NOT stale for replace_prompt when an unrelated field (type) changed', () => {
    const current = structure();
    current.sections[0].questions[0].type = 'single_choice';
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'replace_prompt', prompt: 'X' } },
      structure(),
      current
    );
    expect(result.stale).toBe(false);
  });

  it('is stale when the targeted question was deleted', () => {
    const current = structure();
    current.sections[0].questions = [current.sections[0].questions[1]];
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'replace_prompt', prompt: 'X' } },
      structure(),
      current
    );
    expect(result.stale).toBe(true);
  });

  it('delete_question is NOT stale when the question still exists (still deletable)', () => {
    const current = structure();
    current.sections[0].questions[0].prompt = 'edited';
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'delete_question' } },
      structure(),
      current
    );
    expect(result.stale).toBe(false);
  });

  it('edit_guidelines is stale only when the guidelines changed', () => {
    const same = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'edit_guidelines', guidelines: 'new' } },
      structure(),
      structure()
    );
    expect(same.stale).toBe(false);

    const current = structure();
    current.sections[0].questions[0].guidelines = 'edited by hand';
    const changed = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'edit_guidelines', guidelines: 'new' } },
      structure(),
      current
    );
    expect(changed.stale).toBe(true);
  });

  it('reorder is stale when the question moved position since the run', () => {
    const current = structure();
    // Swap the two questions so q_role is no longer at index 0.
    current.sections[0].questions = [
      current.sections[0].questions[1],
      current.sections[0].questions[0],
    ];
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'reorder', ordinal: 0 } },
      structure(),
      current
    );
    expect(result.stale).toBe(true);
  });

  it('a prose-only finding on a slot is stale when addressed content changed', () => {
    const current = structure();
    current.sections[0].questions[0].prompt = 'reworded by hand';
    const result = deriveFindingState({ targetKey: 'q_role', op: null }, structure(), current);
    expect(result.stale).toBe(true);
    expect(result.applicable).toBe('manual');
  });

  it('is not stale when the key was absent from the snapshot (can’t reason about drift)', () => {
    const result = deriveFindingState(
      { targetKey: 'q_missing', op: { op: 'replace_prompt', prompt: 'X' } },
      structure(),
      structure()
    );
    expect(result.stale).toBe(false);
  });

  it('change_type is stale only when the type changed', () => {
    const sameType = deriveFindingState(
      { targetKey: 'q_team', op: { op: 'change_type', type: 'multi_choice' } },
      structure(),
      structure()
    );
    expect(sameType.stale).toBe(false);

    const current = structure();
    current.sections[0].questions[1].type = 'multi_choice';
    const changed = deriveFindingState(
      { targetKey: 'q_team', op: { op: 'change_type', type: 'likert' } },
      structure(),
      current
    );
    expect(changed.stale).toBe(true);
  });
});

describe('deriveFindingState — version + section targets', () => {
  it('goal: stale when the goal changed', () => {
    const current = structure({ goal: 'A different goal' });
    const result = deriveFindingState(
      { targetKey: 'goal', op: { op: 'edit_goal', goal: 'X' } },
      structure(),
      current
    );
    expect(result.stale).toBe(true);
  });

  it('audience: stale only when a PATCHED sub-field changed', () => {
    const current = structure({ audience: { expertiseLevel: 'novice', role: 'new hire' } });
    const patchedChanged = deriveFindingState(
      {
        targetKey: 'audience',
        op: { op: 'edit_audience', audience: { expertiseLevel: 'expert' } },
      },
      structure(),
      current
    );
    expect(patchedChanged.stale).toBe(true);

    const untouchedChanged = deriveFindingState(
      { targetKey: 'audience', op: { op: 'edit_audience', audience: { role: 'manager' } } },
      structure(),
      current // only expertiseLevel changed; role unchanged from snapshot
    );
    expect(untouchedChanged.stale).toBe(false);
  });

  it('audience (prose-only): stale when the whole audience shape changed', () => {
    const current = structure({ audience: { expertiseLevel: 'expert', role: 'new hire' } });
    const result = deriveFindingState({ targetKey: 'audience', op: null }, structure(), current);
    expect(result.stale).toBe(true);
  });

  it('section: stale when the titled section is gone or now ambiguous', () => {
    const gone = deriveFindingState(
      { targetKey: 'section:Background', op: null },
      structure(),
      structure({ sections: [] })
    );
    expect(gone.stale).toBe(true);

    const dup = structure();
    dup.sections.push({ title: 'Background', questions: [] });
    const ambiguous = deriveFindingState(
      { targetKey: 'section:Background', op: null },
      structure(),
      dup
    );
    expect(ambiguous.stale).toBe(true);
  });
});

describe('deriveFindingState — no snapshot', () => {
  it('returns not-stale (best-effort) when the run predates snapshots', () => {
    const result = deriveFindingState(
      { targetKey: 'q_role', op: { op: 'replace_prompt', prompt: 'X' } },
      null,
      structure()
    );
    expect(result.stale).toBe(false);
    expect(result.applicable).toBe('apply');
  });
});
