import { describe, expect, it } from 'vitest';

import {
  EVALUATION_DIMENSIONS,
  buildJudgePrompt,
  buildJudgeRetryMessage,
  MAX_FINDINGS_PER_JUDGE,
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

  it('states the schema findings cap in the prompt, taken from the schema constant', () => {
    // The cap is only enforced by Zod after the fact: a judge that emits 51 findings fails
    // validation and its whole verdict is thrown away. Stating the same number the schema
    // enforces — and reading it from that constant so the two cannot drift — turns a hard
    // failure into a bounded answer. Every dimension carries it, not just clarity.
    for (const dimension of ['clarity', 'coverage', 'type_fit'] as const) {
      const system = buildJudgePrompt(dimension, STRUCTURE)[0].content;
      expect(system).toContain(`at most ${MAX_FINDINGS_PER_JUDGE} findings`);
      expect(system).toContain('most severe first');
    }
  });

  it('tells every judge to lead with the alternative, not the complaint', () => {
    // A critique the admin cannot act on is a to-do, not a finding. Every dimension carries the
    // instruction, and it names `proposedChange` as the place the alternative goes — the field
    // the review queue and the pack actually render.
    for (const dimension of EVALUATION_DIMENSIONS) {
      const system = buildJudgePrompt(dimension, STRUCTURE)[0].content;
      expect(system).toContain('Lead with the fix, not the complaint');
      expect(system).toContain('"proposedChange" must BE that alternative');
    }
  });

  it('lets a judge diagnose without an alternative when it cannot responsibly propose one', () => {
    // The escape hatch has to stay open: a judge pressed to always rewrite will invent facts it
    // cannot see. The rule is "prefer an alternative", not "never report what you cannot fix".
    const system = buildJudgePrompt('clarity', STRUCTURE)[0].content;
    expect(system).toContain('Only diagnose without an alternative when you genuinely cannot');
  });

  it('asks judges to prefer a structured edit rather than only permitting one', () => {
    // The old wording ("attach ONLY when ... you are confident of every field") read as a
    // discouragement and left applicable fixes as prose the admin had to retype.
    const system = buildJudgePrompt('clarity', STRUCTURE)[0].content;
    expect(system).toContain('Prefer attaching "proposedEdit"');
    // The guard against invention survives the softening.
    expect(system).toContain('never invent a key, section title, or type');
  });

  it('has the delete-first judges offer a salvage before a deletion', () => {
    // Duplicates and Goal-Match are the two dimensions whose natural op removes a question.
    // Both should reach for a rewrite that keeps the slot when one exists.
    const duplicates = buildJudgePrompt('duplicates', STRUCTURE)[0].content;
    expect(duplicates).toContain('prefer salvaging over deleting');
    expect(duplicates).toContain('replace_prompt');

    const goalMatch = buildJudgePrompt('goal_match', STRUCTURE)[0].content;
    expect(goalMatch).toContain('prefer the refocus');
    expect(goalMatch).toContain('replace_prompt');
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

  it('asks for brevity when there are no paths, since the likely cause is truncation', () => {
    // No issue paths means the first response never parsed — usually a fence or an answer cut
    // off at the token cap. The retry reuses the same cap, so "be shorter" is the only advice
    // that can actually clear it; the path-named branch must NOT carry that advice, because a
    // schema-invalid response needs the field fixed, not shortened.
    expect(buildJudgeRetryMessage([])).toContain('Keep the response short');
    expect(buildJudgeRetryMessage(['score'])).not.toContain('Keep the response short');
  });
});

/**
 * The inert-by-construction gate (F17.34).
 *
 * The routing overlay is optional and absent on every questionnaire that does not use Conditional
 * Topics — which is most of them. This pins that absence: a structure with no `routing` block must
 * produce exactly the prompt it produced before the overlay existed, for every dimension. If this
 * fails, the feature has leaked a sentence about routing into prompts for questionnaires that have
 * none, and every score in the product moved.
 */
describe('buildJudgePrompt — with no routing overlay', () => {
  it('says nothing about routing, on any dimension', () => {
    // Asserted on the overlay's own markers, not the bare word "topic": the Coverage rubric has
    // always said "name the missing topic" in ordinary English, and always should.
    for (const dimension of EVALUATION_DIMENSIONS) {
      const [system, user] = buildJudgePrompt(dimension, STRUCTURE);
      expect(system.content).not.toMatch(/CO-OCCURRENCE/);
      expect(system.content).not.toMatch(/asked when it fits/i);
      expect(user.content).not.toMatch(/topic=/);
      expect(user.content).not.toMatch(/^ROUTING/m);
    }
  });

  it('renders questions with the same flags line as before the overlay', () => {
    const user = buildJudgePrompt('duplicates', STRUCTURE)[1].content;
    // `type=…, required` and nothing appended — the shape every existing assertion depends on.
    expect(user).toMatch(/\[key=q_role\] \(type=free_text, required\) /);
  });
});
