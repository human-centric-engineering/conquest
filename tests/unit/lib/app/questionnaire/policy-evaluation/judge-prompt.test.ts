/**
 * The interviewer-policy judge prompts.
 *
 * Two properties carry the panel's cost and its honesty:
 *
 * 1. **Per-dimension sections.** Three of the four rubrics have no use for the question list, and a
 *    policy DTO can carry 150 prompts. Sending them to every judge is real money, so what each is
 *    shown is pinned here.
 * 2. **`knownIssues` are printed with their ids**, and every rubric's ignore clause names ids — so a
 *    judge matches id to id rather than paraphrase to paraphrase, and does not re-report what the
 *    mechanical checker already caught.
 *
 * @see lib/app/questionnaire/policy-evaluation/judge-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import { buildPolicyJudgePrompt } from '@/lib/app/questionnaire/policy-evaluation/judge-prompt';
import { POLICY_EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/policy-evaluation/types';
import type { PolicyStructureInput } from '@/lib/app/questionnaire/policy-evaluation/types';

const STRUCTURE: PolicyStructureInput = {
  meta: {
    title: 'Growth assessment',
    goal: 'Understand how leaders experience growth',
    audienceSummary: '{"role":"Founder"}',
    sectionCount: 2,
    questionCount: 12,
  },
  context: {
    presentationMode: 'both',
    anonymousMode: false,
    sensitivityAwareness: false,
    hasSupportMessage: false,
    answerConfidenceFloor: 0.5,
  },
  tone: {
    personaSelectionEnabled: false,
    personaText: 'Calm and unhurried',
    dials: [{ key: 'humour', label: 'Humour', displayLevel: 2 }],
  },
  houseRules: {
    enabled: true,
    rules: [
      { id: 'r1', kind: 'never', enabled: true, text: 'Never use humour.', trigger: null },
      { id: 'r2', kind: 'always', enabled: false, text: 'A parked draft.', trigger: null },
    ],
  },
  strategy: {
    enabled: true,
    approach: 'funnel',
    pace: 'brisk',
    openingMode: 'examples',
    openingExamples: ['Tell me about your year'],
    probeDepth: true,
    reflect: false,
    batchRelated: true,
    paceProfile: {
      openingWindow: 1,
      openBelow: 0.25,
      targetedAbove: 0.55,
      openRounds: 2,
      targetedRounds: 5,
    },
    guidedOpeningActive: true,
  },
  fidelity: {
    enabled: true,
    defaultFidelity: 0.5,
    defaultLevel: 'balanced',
    distribution: { free: 0, loose: 0, balanced: 11, close: 0, must_ask: 1 },
    satisfactionFloors: { free: 0.5, loose: 0.5, balanced: 0.5, close: 0.65, must_ask: 0.85 },
    questions: [
      {
        key: 'q1',
        prompt: 'How satisfied are you with your revenue engine?',
        type: 'likert',
        required: true,
        weight: 1,
        sectionTitle: 'Growth',
        level: 'must_ask',
        storedLevel: 'must_ask',
        topicKeys: ['revenue'],
      },
    ],
    questionsShown: 1,
    questionsTotal: 12,
    truncated: true,
  },
  routing: {
    adaptiveScopeEnabled: true,
    maxConditionalTopics: 3,
    limitOpeningProbes: true,
    maxOpeningProbes: 1,
    mustAskByTopic: [
      { topicKey: 'revenue', label: 'Revenue', conditional: true, mustAskCount: 1, closeCount: 0 },
    ],
  },
  knownIssues: [
    {
      severity: 'warning',
      id: 'house-rules-format-override',
      title: 'A rule about layout won’t be followed',
      message: 'The reply format is fixed.',
    },
  ],
};

const userOf = (dimension: (typeof POLICY_EVALUATION_DIMENSIONS)[number]): string => {
  const msg = buildPolicyJudgePrompt(dimension, STRUCTURE).find((m) => m.role === 'user');
  return typeof msg?.content === 'string' ? msg.content : '';
};

/** The user message for one dimension against an arbitrary structure. */
const userContentOf = (
  dimension: (typeof POLICY_EVALUATION_DIMENSIONS)[number],
  structure: PolicyStructureInput
): string => {
  const msg = buildPolicyJudgePrompt(dimension, structure).find((m) => m.role === 'user');
  return typeof msg?.content === 'string' ? msg.content : '';
};

const systemOf = (dimension: (typeof POLICY_EVALUATION_DIMENSIONS)[number]): string => {
  const msg = buildPolicyJudgePrompt(dimension, STRUCTURE).find((m) => m.role === 'system');
  return typeof msg?.content === 'string' ? msg.content : '';
};

describe('buildPolicyJudgePrompt — what each judge is shown', () => {
  it('gives every judge the questionnaire and the known issues', () => {
    for (const dimension of POLICY_EVALUATION_DIMENSIONS) {
      const user = userOf(dimension);
      expect(user).toContain('Understand how leaders experience growth');
      expect(user).toContain('house-rules-format-override');
    }
  });

  it('sends the question list ONLY to the two judges that need it', () => {
    // 150 question prompts in a rubric that ignores them is real money on every run.
    expect(userOf('fidelity_calibration')).toContain('revenue engine');
    expect(userOf('cross_layer_conflict')).toContain('revenue engine');
    expect(userOf('rule_coherence')).not.toContain('revenue engine');
    expect(userOf('arc_fit')).not.toContain('revenue engine');
  });

  it('sends tone and routing only to the cross-layer judge', () => {
    // They exist so it can spot "never use humour" against a high humour dial, and must-asks in a
    // topic routing may never seat. No other rubric reasons across blocks.
    expect(userOf('cross_layer_conflict')).toContain('Humour');
    expect(userOf('cross_layer_conflict')).toContain('Adaptive scope is ON');
    expect(userOf('rule_coherence')).not.toContain('Humour +2');
    expect(userOf('fidelity_calibration')).not.toContain('Adaptive scope is ON');
  });

  it('gives the arc judge the pre-computed bands rather than the pace name alone', () => {
    const user = userOf('arc_fit');
    expect(user).toContain('PRE-COMPUTED');
    // The actual numbers — a judge inventing its own is a judge inventing the feature.
    expect(user).toContain('the first 1 question(s)');
    expect(user).toContain('55%');
  });
});

describe('buildPolicyJudgePrompt — honesty about the sample', () => {
  it('tells the fidelity judge what it is not seeing', () => {
    const user = userOf('fidelity_calibration');
    expect(user).toContain('1 of 12 questions');
    expect(user).toContain('The distribution above is complete');
  });

  it('names the mechanical checker as the reason not to repeat an issue', () => {
    expect(userOf('rule_coherence')).toContain('ALREADY CAUGHT BY THE MECHANICAL CONFLICT CHECKER');
  });

  it('only shows rules that are actually in force', () => {
    // A parked rule is a draft; judging one trains the admin to ignore the panel.
    const user = userOf('rule_coherence');
    expect(user).toContain('Never use humour');
    expect(user).not.toContain('A parked draft');
  });
});

describe('buildPolicyJudgePrompt — the rubrics', () => {
  it('tells each judge which check ids are not its job', () => {
    expect(systemOf('rule_coherence')).toContain('house-rules-format-override');
    expect(systemOf('arc_fit')).toContain('opening-examples-targeted');
  });

  it('forbids the cross-layer judge from rewriting rule text', () => {
    // The one real collision risk: it and Rule-Coherence can both target the same rule. Confining
    // it to the other side of the conflict is what replaces a reconciler.
    expect(systemOf('cross_layer_conflict')).toMatch(/Do NOT propose `edit_house_rule`/);
  });

  it('forbids the fidelity judge from proposing question rewrites', () => {
    // Those belong to the question-design panel, and two panels rewriting one prompt is a queue an
    // admin cannot reconcile.
    expect(systemOf('fidelity_calibration')).toMatch(/NEVER propose a prompt rewrite/);
  });

  it('tells every judge that a minimal policy is not a fault', () => {
    for (const dimension of POLICY_EVALUATION_DIMENSIONS) {
      expect(systemOf(dimension)).toContain('is not a fault');
    }
  });
});

describe('buildPolicyJudgePrompt — a bare questionnaire', () => {
  it('says plainly when each block is off rather than rendering an empty section', () => {
    const bare: PolicyStructureInput = {
      ...STRUCTURE,
      houseRules: { enabled: false, rules: [] },
      strategy: { ...STRUCTURE.strategy, enabled: false },
      fidelity: { ...STRUCTURE.fidelity, enabled: false },
      routing: { ...STRUCTURE.routing, adaptiveScopeEnabled: false, mustAskByTopic: [] },
    };
    expect(userContentOf('rule_coherence', bare)).toContain('House rules are switched OFF');
    expect(userContentOf('cross_layer_conflict', bare)).toContain('Adaptive scope is OFF');
  });

  it('tells the fidelity judge that stored values are inert when the gate is off', () => {
    const gateOff: PolicyStructureInput = {
      ...STRUCTURE,
      fidelity: { ...STRUCTURE.fidelity, enabled: false },
    };
    // The headline finding depends on the judge understanding this exactly.
    expect(userContentOf('fidelity_calibration', gateOff)).toContain('WHATEVER a question');
  });
});

describe('buildPolicyJudgePrompt — the render branches', () => {
  it('says a chosen persona has replaced the dials, rather than listing dials that do not apply', () => {
    const withPersona: PolicyStructureInput = {
      ...STRUCTURE,
      tone: { personaSelectionEnabled: true, personaText: 'Warm', dials: [] },
    };
    expect(userContentOf('cross_layer_conflict', withPersona)).toContain(
      'replaces this version’s tone dials'
    );
  });

  it('says the default voice applies when no dial is set', () => {
    const noDials: PolicyStructureInput = {
      ...STRUCTURE,
      tone: { personaSelectionEnabled: false, personaText: null, dials: [] },
    };
    const user = userContentOf('cross_layer_conflict', noDials);
    expect(user).toContain('No tone dial is set');
    expect(user).not.toContain('Persona:');
  });

  it('marks the pace as ignored under an approach that has no arc', () => {
    // Naming a pace under Open or Targeted would describe an arc that is not running.
    const targeted: PolicyStructureInput = {
      ...STRUCTURE,
      strategy: { ...STRUCTURE.strategy, approach: 'targeted' },
    };
    expect(userContentOf('arc_fit', targeted)).toContain('pace applies to the funnel only');
  });

  it('says when written example openings are not actually in use', () => {
    const inert: PolicyStructureInput = {
      ...STRUCTURE,
      strategy: { ...STRUCTURE.strategy, guidedOpeningActive: false },
    };
    expect(userContentOf('arc_fit', inert)).toContain('NOT in use');
  });

  it('says house rules are on but empty, rather than rendering an empty list', () => {
    const noneOn: PolicyStructureInput = {
      ...STRUCTURE,
      houseRules: { enabled: true, rules: [] },
    };
    expect(userContentOf('rule_coherence', noneOn)).toContain('no rule is switched on');
  });

  it('shows a question’s stored level alongside what the interviewer actually does', () => {
    // The headline "gate off, sliders set" finding depends on the judge seeing both.
    const gateOff: PolicyStructureInput = {
      ...STRUCTURE,
      fidelity: {
        ...STRUCTURE.fidelity,
        enabled: false,
        questions: [
          { ...STRUCTURE.fidelity.questions[0], level: 'balanced', storedLevel: 'must_ask' },
        ],
      },
    };
    expect(userContentOf('fidelity_calibration', gateOff)).toContain('the gate is off');
  });

  it('omits the sample caveat when nothing was truncated', () => {
    const whole: PolicyStructureInput = {
      ...STRUCTURE,
      fidelity: { ...STRUCTURE.fidelity, truncated: false, questionsTotal: 1 },
    };
    expect(userContentOf('fidelity_calibration', whole)).not.toContain('You are seeing');
  });

  it('states plainly when the mechanical checker found nothing', () => {
    const clean: PolicyStructureInput = { ...STRUCTURE, knownIssues: [] };
    expect(userContentOf('rule_coherence', clean)).toContain('conflict checker found nothing');
  });

  it('marks a conditional topic as one routing may never seat', () => {
    expect(userContentOf('cross_layer_conflict', STRUCTURE)).toContain('may not be seated');
  });

  it('names a missing goal and audience rather than printing nothing', () => {
    const bare: PolicyStructureInput = {
      ...STRUCTURE,
      meta: { ...STRUCTURE.meta, goal: null, audienceSummary: null },
    };
    const user = userContentOf('arc_fit', bare);
    expect(user).toContain('(none stated)');
  });

  it('flags a sensitivity setting with no support message', () => {
    const risky: PolicyStructureInput = {
      ...STRUCTURE,
      context: { ...STRUCTURE.context, sensitivityAwareness: true, hasSupportMessage: false },
    };
    expect(userContentOf('rule_coherence', risky)).toContain('no support message set');
  });
});
