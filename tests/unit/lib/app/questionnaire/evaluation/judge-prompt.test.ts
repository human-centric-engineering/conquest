import { describe, expect, it } from 'vitest';

import {
  EVALUATION_DIMENSIONS,
  buildJudgePrompt,
  buildJudgeRetryMessage,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';

const STRUCTURE: VersionStructureInput = {
  goal: 'Understand developer onboarding friction.',
  audience: {
    description: 'New engineering hires',
    role: 'Software engineer',
    expertiseLevel: 'intermediate',
    estimatedDurationMinutes: 10,
    sensitivity: 'low',
  },
  sections: [
    {
      title: 'Background',
      description: 'A little about you.',
      questions: [
        { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
        {
          key: 'q_team',
          prompt: 'Which team are you on?',
          type: 'single_choice',
          required: false,
          guidelines: 'Pick the closest match.',
        },
      ],
    },
    {
      title: 'Experience',
      questions: [
        { key: 'q_rating', prompt: 'Rate your onboarding.', type: 'likert', required: true },
      ],
    },
  ],
};

describe('buildJudgePrompt', () => {
  it('returns a system + user message pair', () => {
    const messages = buildJudgePrompt('clarity', STRUCTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('splices a dimension-specific rubric into the system message', () => {
    const clarity = buildJudgePrompt('clarity', STRUCTURE)[0].content;
    const coverage = buildJudgePrompt('coverage', STRUCTURE)[0].content;
    expect(clarity).toContain('single-barrelled');
    expect(coverage).toContain('GOAL');
    // Different dimensions yield different system prompts.
    expect(clarity).not.toBe(coverage);
  });

  it('serialises goal, audience, section titles, and every question with key + type', () => {
    const user = buildJudgePrompt('clarity', STRUCTURE)[1].content;
    expect(user).toContain('Understand developer onboarding friction.');
    expect(user).toContain('New engineering hires');
    expect(user).toContain('Section: Background');
    expect(user).toContain('Section: Experience');
    expect(user).toContain('key=q_role');
    expect(user).toContain('type=free_text');
    expect(user).toContain('key=q_rating');
    expect(user).toContain('type=likert');
    // Author guidance is included when present.
    expect(user).toContain('Pick the closest match.');
    // required/optional flags surface.
    expect(user).toContain('required');
    expect(user).toContain('optional');
  });

  it('numbers questions continuously across sections', () => {
    const user = buildJudgePrompt('ordering', STRUCTURE)[1].content;
    // 2 questions in Background, then the 3rd in Experience.
    expect(user).toMatch(/3\.\s+\[key=q_rating\]/);
  });

  it('renders placeholders when goal and audience are absent', () => {
    const user = buildJudgePrompt('coverage', {
      goal: null,
      audience: null,
      sections: [],
    })[1].content;
    expect(user).toContain('(no goal specified)');
    expect(user).toContain('(no audience specified)');
  });

  it('shows the no-audience placeholder for a present-but-empty audience object', () => {
    // audience: {} is structurally present but has no resolved fields → same
    // placeholder as a null audience (the `lines.length > 0` false branch).
    const user = buildJudgePrompt('audience_match', { goal: 'g', audience: {}, sections: [] })[1]
      .content;
    expect(user).toContain('(no audience specified)');
  });

  it('renders the optional locale and notes audience fields when present', () => {
    const user = buildJudgePrompt('audience_match', {
      goal: 'g',
      audience: { locale: 'en-GB', notes: 'keep it brief' },
      sections: [],
    })[1].content;
    expect(user).toContain('locale: en-GB');
    expect(user).toContain('notes: keep it brief');
  });

  it('handles a structure with no sections', () => {
    const messages = buildJudgePrompt('clarity', { goal: 'g', audience: null, sections: [] });
    expect(messages[1].content).toContain('(no sections or questions)');
  });

  it('renders the (no questions) marker for a section with zero questions', () => {
    const user = buildJudgePrompt('ordering', {
      goal: 'g',
      audience: null,
      sections: [{ title: 'Empty', questions: [] }],
    })[1].content;
    expect(user).toContain('Section: Empty');
    expect(user).toContain('(no questions)');
  });

  it('builds a non-trivial system prompt for every dimension (every dimension has a rubric)', () => {
    // Rubric-completeness parity: each registered dimension must splice a real rubric
    // into the system message. Lives here (not in dimension-parity) because it
    // exercises the prompt builder, not the registry.
    for (const dimension of EVALUATION_DIMENSIONS) {
      const messages = buildJudgePrompt(dimension, { goal: null, audience: null, sections: [] });
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content.length).toBeGreaterThan(200);
    }
  });

  it('is deterministic for the same input', () => {
    expect(buildJudgePrompt('type_fit', STRUCTURE)).toEqual(
      buildJudgePrompt('type_fit', STRUCTURE)
    );
  });

  it('states the targetKey addressing convention so findings are reconcilable', () => {
    const system = buildJudgePrompt('duplicates', STRUCTURE)[0].content;
    expect(system).toContain('targetKey');
    expect(system).toContain('section:');
  });
});

describe('buildJudgeRetryMessage', () => {
  it('names the invalid field paths when provided', () => {
    const msg = buildJudgeRetryMessage(['score', 'findings.0.severity']);
    expect(msg).toContain('score');
    expect(msg).toContain('findings.0.severity');
  });

  it('falls back to a generic message with no paths', () => {
    const msg = buildJudgeRetryMessage([]);
    expect(msg).toContain('not valid JSON');
  });
});
