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

/**
 * The prompt WITH the routing overlay (F17.34).
 *
 * The rules here are scoped to three dimensions and only appear when Conditional Topics is actually
 * configured. Both halves of that are asserted: a rule reaching a dimension it is not for is
 * attention spent for nothing, and a rule reaching a version that does not route is a claim about a
 * feature the questionnaire has not got.
 */
describe('buildJudgePrompt — with the routing overlay', () => {
  const ROUTED: VersionStructureInput = {
    goal: 'Understand how the team is performing',
    audience: null,
    routing: {
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
    },
    sections: [
      {
        title: 'Start',
        questions: [
          {
            key: 'q_broad',
            prompt: 'What is going well and what is not?',
            type: 'free_text',
            required: true,
            topicKeys: ['opening'],
          },
          {
            key: 'q_deep',
            prompt: 'What is hard about hiring right now?',
            type: 'free_text',
            required: false,
            topicKeys: ['depth'],
          },
          {
            key: 'q_orphan',
            prompt: 'Anything else?',
            type: 'free_text',
            required: false,
            topicKeys: [],
          },
        ],
      },
    ],
  };

  it('frames routing above the structure and states the proportion', () => {
    // The ratio, not just the rule: a judge told how much of the instrument is conditional
    // calibrates severity far better than one handed a rule alone.
    const user = buildJudgePrompt('duplicates', ROUTED)[1].content;

    expect(user).toContain('ROUTING — this questionnaire does not ask all of itself to everyone.');
    expect(user).toContain('1 of the 3 question(s) below are in an "asked-when-it-fits" topic');
  });

  it('mentions the per-interview cap only where it can actually bind', () => {
    // "At most 3 of them are chosen" beside a single conditional topic is incoherent, and a frame
    // a judge half-disbelieves is worse than a shorter one it can take at face value.
    expect(buildJudgePrompt('duplicates', ROUTED)[1].content).not.toContain('At most');

    const capped: VersionStructureInput = {
      ...ROUTED,
      routing: {
        ...ROUTED.routing!,
        maxConditionalTopics: 1,
        topics: [
          ...ROUTED.routing!.topics,
          { key: 'other', label: 'Other', phase: 'conditional', depth: 'full', questionCount: 0 },
        ],
      },
    };
    expect(buildJudgePrompt('duplicates', capped)[1].content).toContain(
      'At most 1 of them are chosen for any one respondent.'
    );
  });

  it('lists the topics with their plain-English phase and size', () => {
    const user = buildJudgePrompt('duplicates', ROUTED)[1].content;

    expect(user).toContain('Opening (opening) — opening, 1 question(s)');
    expect(user).toContain('Talent depth (depth) — asked-when-it-fits, 1 question(s)');
    // A light topic says so, because "deleting this guts the topic" is judged on it.
    expect(user).toContain('only the most important few are asked');
  });

  it('annotates each question with its topic in the same words the rule uses', () => {
    const user = buildJudgePrompt('duplicates', ROUTED)[1].content;

    expect(user).toContain('[key=q_broad] (type=free_text, required, topic=opening/opening)');
    expect(user).toContain(
      '[key=q_deep] (type=free_text, optional, topic=depth/asked-when-it-fits)'
    );
  });

  it('says outright that a question in no topic can never be asked', () => {
    const user = buildJudgePrompt('duplicates', ROUTED)[1].content;

    expect(user).toContain('topic=NONE — never asked while routing is on');
  });

  it('gives the Duplicates judge the co-occurrence rule, and the scale line that protects the score', () => {
    const system = buildJudgePrompt('duplicates', ROUTED)[0].content;

    expect(system).toContain('CO-OCCURRENCE');
    expect(system).toContain(
      'Two questions are only duplicates if the SAME respondent is asked both'
    );
    expect(system).toContain('Never propose delete_question for it');
    expect(system).toContain('does not lower the score');
  });

  it('gives Ordering and Goal-Match their own routing rules', () => {
    expect(buildJudgePrompt('ordering', ROUTED)[0].content).toContain(
      'the phases ARE the sequence'
    );
    expect(buildJudgePrompt('goal_match', ROUTED)[0].content).toContain(
      'a narrow question is not automatically off-mission'
    );
  });

  it('gives the co-occurrence rule to Duplicates and to no other dimension', () => {
    for (const dimension of EVALUATION_DIMENSIONS) {
      const system = buildJudgePrompt(dimension, ROUTED)[0].content;
      if (dimension === 'duplicates') expect(system).toContain('CO-OCCURRENCE');
      else expect(system).not.toContain('CO-OCCURRENCE');
    }
  });

  it('leaves the four uninvolved dimensions’ system prompts exactly as they were', () => {
    // Clarity, Coverage, Type-Fit and Audience-Match judge things routing does not change. Adding a
    // paragraph to them would cost attention on every routed questionnaire and buy nothing.
    for (const dimension of ['clarity', 'coverage', 'type_fit', 'audience_match'] as const) {
      expect(buildJudgePrompt(dimension, ROUTED)[0].content).toEqual(
        buildJudgePrompt(dimension, STRUCTURE)[0].content
      );
    }
  });

  it('tells the Duplicates judge to narrow rather than delete inside a conditional topic', () => {
    const system = buildJudgePrompt('duplicates', ROUTED)[0].content;

    expect(system).toContain('prefer `replace_prompt` over deleting');
  });
});
