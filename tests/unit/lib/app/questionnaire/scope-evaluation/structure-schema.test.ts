import { describe, expect, it } from 'vitest';

import {
  MAX_SCOPE_EVAL_TOPICS,
  MAX_SCOPE_EVAL_MEMBERS_PER_TOPIC,
  MAX_SCOPE_EVAL_ISSUES,
  scopeStructureSchema,
} from '@/lib/app/questionnaire/scope-evaluation';

const base = {
  topics: [
    {
      key: 'background',
      label: 'Background',
      phase: 'opening',
      criteria: null,
      depth: 'full',
      members: [{ key: 'q1', label: 'Tell me about today.' }],
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
  costs: { budgetSeconds: 600, alwaysSeconds: 60, routedAllowanceSeconds: 540, perTopic: [] },
  knownIssues: [],
};

describe('scopeStructureSchema', () => {
  it('accepts a well-formed structure', () => {
    expect(scopeStructureSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an empty topics/rules/knownIssues structure', () => {
    const result = scopeStructureSchema.safeParse({ ...base, topics: [], rules: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a topic with a null criteria', () => {
    const result = scopeStructureSchema.safeParse({
      ...base,
      topics: [{ ...base.topics[0], criteria: null }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a topic with populated criteria', () => {
    const result = scopeStructureSchema.safeParse({
      ...base,
      topics: [{ ...base.topics[0], criteria: 'When the respondent mentions X.' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a topic with an empty key', () => {
    const result = scopeStructureSchema.safeParse({
      ...base,
      topics: [{ ...base.topics[0], key: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown topic phase', () => {
    const result = scopeStructureSchema.safeParse({
      ...base,
      topics: [{ ...base.topics[0], phase: 'mystery' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a knownIssue with and without the optional topicKey', () => {
    const withKey = scopeStructureSchema.safeParse({
      ...base,
      knownIssues: [{ severity: 'warning', code: 'x', message: 'y', topicKey: 'background' }],
    });
    const withoutKey = scopeStructureSchema.safeParse({
      ...base,
      knownIssues: [{ severity: 'error', code: 'x', message: 'y' }],
    });
    expect(withKey.success).toBe(true);
    expect(withoutKey.success).toBe(true);
  });

  it('rejects an unknown knownIssue severity', () => {
    const result = scopeStructureSchema.safeParse({
      ...base,
      knownIssues: [{ severity: 'catastrophic', code: 'x', message: 'y' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more topics than the cap', () => {
    const topics = Array.from({ length: MAX_SCOPE_EVAL_TOPICS + 1 }, (_, i) => ({
      ...base.topics[0],
      key: `t${i}`,
    }));
    expect(scopeStructureSchema.safeParse({ ...base, topics }).success).toBe(false);
  });

  it('rejects more members on a topic than the cap', () => {
    const members = Array.from({ length: MAX_SCOPE_EVAL_MEMBERS_PER_TOPIC + 1 }, (_, i) => ({
      key: `m${i}`,
      label: `m${i}`,
    }));
    const result = scopeStructureSchema.safeParse({
      ...base,
      topics: [{ ...base.topics[0], members }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more knownIssues than the cap', () => {
    const knownIssues = Array.from({ length: MAX_SCOPE_EVAL_ISSUES + 1 }, (_, i) => ({
      severity: 'warning',
      code: `c${i}`,
      message: 'y',
    }));
    expect(scopeStructureSchema.safeParse({ ...base, knownIssues }).success).toBe(false);
  });
});
