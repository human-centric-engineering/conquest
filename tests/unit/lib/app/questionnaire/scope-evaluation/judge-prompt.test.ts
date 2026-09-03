import { describe, expect, it } from 'vitest';

import {
  SCOPE_EVALUATION_DIMENSIONS,
  buildScopeJudgePrompt,
  buildScopeJudgeRetryMessage,
  MAX_SCOPE_FINDINGS_PER_JUDGE,
  type ScopeStructureInput,
} from '@/lib/app/questionnaire/scope-evaluation';

const STRUCTURE: ScopeStructureInput = {
  topics: [
    {
      key: 'background',
      label: 'Background',
      phase: 'opening',
      criteria: null,
      depth: 'full',
      members: [{ key: 'q1', label: 'Tell me about today.' }],
    },
    {
      key: 'talent',
      label: 'Talent & culture',
      phase: 'conditional',
      criteria: 'The respondent mentions hiring difficulty or turnover.',
      depth: 'full',
      members: [{ key: 'q2', label: 'How is retention?' }],
    },
    {
      key: 'compliance-check',
      label: 'Compliance blind-spot check',
      phase: 'conditional',
      criteria: 'Sampled lightly when nothing else pointed at compliance.',
      depth: 'light',
      members: [],
    },
  ],
  settings: {
    maxConditionalTopics: 3,
    includeCheckTopic: true,
    fallbackTopicKeys: [],
    minConfidence: 0.6,
    plannerInstructions: '',
    sessionBudgetSeconds: 600,
    limitOpeningProbes: false,
    maxOpeningProbes: 1,
  },
  costs: {
    budgetSeconds: 600,
    alwaysSeconds: 60,
    routedAllowanceSeconds: 540,
    perTopic: [{ key: 'talent', fullSeconds: 120, lightSeconds: 40 }],
  },
  knownIssues: [
    { severity: 'warning', code: 'orphaned_questions', message: 'Already flagged elsewhere.' },
  ],
};

describe('buildScopeJudgePrompt', () => {
  it('returns a system + user message pair', () => {
    const messages = buildScopeJudgePrompt('criteria_quality', STRUCTURE);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('states the schema findings cap in the prompt, taken from the schema constant', () => {
    // The cap is only enforced by Zod after the fact — stating the same number the schema
    // enforces, read from that constant, turns a hard failure into a bounded answer.
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const system = buildScopeJudgePrompt(dimension, STRUCTURE)[0].content;
      expect(system).toContain(`at most ${MAX_SCOPE_FINDINGS_PER_JUDGE} findings`);
      expect(system).toContain('most severe first');
    }
  });

  it('tells every judge to lead with the fix, not the complaint', () => {
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const system = buildScopeJudgePrompt(dimension, STRUCTURE)[0].content;
      expect(system).toContain('Lead with the fix, not the complaint');
      expect(system).toContain('"proposedChange" must BE that alternative');
    }
  });

  it('states the goal Conditional Topics serves, so every judge shares the same north star', () => {
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const system = buildScopeJudgePrompt(dimension, STRUCTURE)[0].content;
      expect(system).toContain('minimise how much a respondent is asked');
      expect(system).toContain('WITHOUT ever silently dropping a topic that does apply');
    }
  });

  it('splices a dimension-specific rubric into the system message', () => {
    const criteria = buildScopeJudgePrompt('criteria_quality', STRUCTURE)[0].content;
    const budget = buildScopeJudgePrompt('budget_realism', STRUCTURE)[0].content;
    expect(criteria).toContain('CONDITIONAL topic');
    expect(budget).toContain('PRE-COMPUTED cost figures');
    // Different dimensions yield different system prompts.
    expect(criteria).not.toBe(budget);
  });

  it('tells every dimension what the coherence checker already caught, so judges do not repeat it', () => {
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const system = buildScopeJudgePrompt(dimension, STRUCTURE)[0].content;
      expect(system).toMatch(/IGNORE/);
    }
  });

  it('serialises topics, settings, costs, and known issues into the user message', () => {
    const user = buildScopeJudgePrompt('criteria_quality', STRUCTURE)[1].content;
    expect(user).toContain('TOPICS (3)');
    expect(user).toContain('key=background');
    expect(user).toContain('key=talent');
    expect(user).toContain('The respondent mentions hiring difficulty or turnover.');
    expect(user).toContain('max conditional topics per interview: 3');
    expect(user).toContain('TIME ARITHMETIC');
    expect(user).toContain('ALREADY CAUGHT BY THE MECHANICAL COHERENCE CHECKER');
    expect(user).toContain('orphaned_questions');
  });

  it('marks always-run topics as needing no criteria', () => {
    const user = buildScopeJudgePrompt('criteria_quality', STRUCTURE)[1].content;
    expect(user).toContain('(always run — no criteria needed)');
  });

  it('renders "(none)" for a topic with no members', () => {
    const user = buildScopeJudgePrompt('coverage_and_burden', STRUCTURE)[1].content;
    expect(user).toContain('(no members)');
  });

  it('renders "(none)" for empty known issues', () => {
    const user = buildScopeJudgePrompt('criteria_quality', { ...STRUCTURE, knownIssues: [] })[1]
      .content;
    expect(user).toContain(
      'ALREADY CAUGHT BY THE MECHANICAL COHERENCE CHECKER (do not repeat these as findings):\n(none)'
    );
  });

  it('renders "(no budget limit set)" style text when the budget is 0', () => {
    const user = buildScopeJudgePrompt('budget_realism', {
      ...STRUCTURE,
      costs: { ...STRUCTURE.costs, budgetSeconds: 0 },
    })[1].content;
    expect(user).toContain('(none set)');
  });

  it('is deterministic for the same input', () => {
    expect(buildScopeJudgePrompt('budget_realism', STRUCTURE)).toEqual(
      buildScopeJudgePrompt('budget_realism', STRUCTURE)
    );
  });

  it('states the targetKey addressing convention so findings are appliable', () => {
    const system = buildScopeJudgePrompt('coverage_and_burden', STRUCTURE)[0].content;
    expect(system).toContain('targetKey');
    expect(system).toContain('topic:<key>');
  });

  it('builds a non-trivial system prompt for every dimension (every dimension has a rubric)', () => {
    for (const dimension of SCOPE_EVALUATION_DIMENSIONS) {
      const messages = buildScopeJudgePrompt(dimension, { ...STRUCTURE, topics: [] });
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content.length).toBeGreaterThan(200);
    }
  });
});

describe('buildScopeJudgeRetryMessage', () => {
  it('names the invalid field paths when provided', () => {
    const msg = buildScopeJudgeRetryMessage(['score', 'findings.0.severity']);
    expect(msg).toContain('score');
    expect(msg).toContain('findings.0.severity');
  });

  it('falls back to a generic message with no paths', () => {
    const msg = buildScopeJudgeRetryMessage([]);
    expect(msg).toContain('not valid JSON');
  });

  it('asks for brevity when there are no paths, since the likely cause is truncation', () => {
    expect(buildScopeJudgeRetryMessage([])).toContain('Keep the response short');
    expect(buildScopeJudgeRetryMessage(['score'])).not.toContain('Keep the response short');
  });
});
