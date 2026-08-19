import { describe, expect, it } from 'vitest';

import {
  MAX_SCOPE_FINDINGS_PER_JUDGE,
  validateScopeJudgeVerdict,
  coerceScopeProposedEdit,
} from '@/lib/app/questionnaire/scope-evaluation';

const validFinding = {
  targetKey: 'topic:talent',
  severity: 'major' as const,
  proposedChange: 'Make the criteria more specific and observable.',
  rationale: 'The current wording is too broad to reliably trigger this topic.',
  sourceQuote: 'when relevant',
};

describe('validateScopeJudgeVerdict', () => {
  it('accepts a well-formed verdict with findings', () => {
    const result = validateScopeJudgeVerdict({ score: 0.6, findings: [validFinding] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(0.6);
      expect(result.value.findings).toHaveLength(1);
      expect(result.value.findings[0].targetKey).toBe('topic:talent');
    }
  });

  it('accepts a clean pass — empty findings array', () => {
    const result = validateScopeJudgeVerdict({ score: 1, findings: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings).toEqual([]);
  });

  it('accepts a finding without the optional sourceQuote', () => {
    const { sourceQuote: _omit, ...noQuote } = validFinding;
    const result = validateScopeJudgeVerdict({ score: 0.5, findings: [noQuote] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings[0].sourceQuote).toBeUndefined();
  });

  it('accepts the boundary scores 0 and 1', () => {
    expect(validateScopeJudgeVerdict({ score: 0, findings: [] }).ok).toBe(true);
    expect(validateScopeJudgeVerdict({ score: 1, findings: [] }).ok).toBe(true);
  });

  it('rejects a score above 1 and surfaces the issue path', () => {
    const result = validateScopeJudgeVerdict({ score: 1.4, findings: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'score')).toBe(true);
    }
  });

  it('rejects a negative score', () => {
    expect(validateScopeJudgeVerdict({ score: -0.1, findings: [] }).ok).toBe(false);
  });

  it('rejects a non-numeric score', () => {
    expect(validateScopeJudgeVerdict({ score: 'high', findings: [] }).ok).toBe(false);
  });

  it('rejects an unknown severity', () => {
    const result = validateScopeJudgeVerdict({
      score: 0.5,
      findings: [{ ...validFinding, severity: 'critical' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.').includes('severity'))).toBe(true);
    }
  });

  it('rejects an empty proposedChange / rationale / targetKey', () => {
    expect(
      validateScopeJudgeVerdict({ score: 0.5, findings: [{ ...validFinding, proposedChange: '' }] })
        .ok
    ).toBe(false);
    expect(
      validateScopeJudgeVerdict({ score: 0.5, findings: [{ ...validFinding, rationale: '' }] }).ok
    ).toBe(false);
    expect(
      validateScopeJudgeVerdict({ score: 0.5, findings: [{ ...validFinding, targetKey: '' }] }).ok
    ).toBe(false);
  });

  it('rejects more findings than the per-judge cap', () => {
    const tooMany = Array.from({ length: MAX_SCOPE_FINDINGS_PER_JUDGE + 1 }, () => validFinding);
    const result = validateScopeJudgeVerdict({ score: 0.5, findings: tooMany });
    expect(result.ok).toBe(false);
  });

  it('accepts exactly the per-judge cap', () => {
    const atCap = Array.from({ length: MAX_SCOPE_FINDINGS_PER_JUDGE }, () => validFinding);
    expect(validateScopeJudgeVerdict({ score: 0.5, findings: atCap }).ok).toBe(true);
  });

  it('rejects a missing findings array', () => {
    expect(validateScopeJudgeVerdict({ score: 0.5 }).ok).toBe(false);
  });
});

describe('scope judge finding.proposedEdit', () => {
  const base = {
    targetKey: 'rule:rule-1',
    severity: 'minor' as const,
    proposedChange: 'Delete this rule.',
    rationale: 'It duplicates what the topic criteria already ensures.',
  };

  it('accepts a finding carrying a delete_rule op', () => {
    const result = validateScopeJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, proposedEdit: { op: 'delete_rule' } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings[0].proposedEdit).toEqual({ op: 'delete_rule' });
  });

  it('accepts a finding with no proposedEdit (prose-only)', () => {
    const result = validateScopeJudgeVerdict({ score: 0.5, findings: [base] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings[0].proposedEdit).toBeUndefined();
  });

  it('rejects a verdict whose proposedEdit has an unknown op', () => {
    const result = validateScopeJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, proposedEdit: { op: 'rename_everything' } }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects adjust_budget with no field set', () => {
    const result = validateScopeJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, proposedEdit: { op: 'adjust_budget' } }],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts adjust_budget with just one field set', () => {
    const result = validateScopeJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, proposedEdit: { op: 'adjust_budget', sessionBudgetSeconds: 600 } }],
    });
    expect(result.ok).toBe(true);
  });
});

describe('coerceScopeProposedEdit', () => {
  it('returns the validated op for a well-formed edit', () => {
    expect(coerceScopeProposedEdit({ op: 'delete_rule' })).toEqual({ op: 'delete_rule' });
    expect(coerceScopeProposedEdit({ op: 'edit_topic_depth', depth: 'light' })).toEqual({
      op: 'edit_topic_depth',
      depth: 'light',
    });
  });

  it('degrades null / undefined / malformed ops to null (never throws)', () => {
    expect(coerceScopeProposedEdit(null)).toBeNull();
    expect(coerceScopeProposedEdit(undefined)).toBeNull();
    expect(coerceScopeProposedEdit({ op: 'edit_topic_depth', depth: 'extreme' })).toBeNull();
    expect(coerceScopeProposedEdit({ op: 'edit_topic_criteria' })).toBeNull(); // missing criteria
    expect(coerceScopeProposedEdit('garbage')).toBeNull();
  });

  it('accepts a well-formed add_rule op', () => {
    const op = coerceScopeProposedEdit({
      op: 'add_rule',
      dataSlotKey: 'headcount',
      operator: 'gt',
      value: '50',
      action: 'include',
      topicKey: 'talent',
    });
    expect(op).toMatchObject({ op: 'add_rule', dataSlotKey: 'headcount', action: 'include' });
  });

  it('accepts add_fallback_topic', () => {
    expect(coerceScopeProposedEdit({ op: 'add_fallback_topic', topicKey: 'compliance' })).toEqual({
      op: 'add_fallback_topic',
      topicKey: 'compliance',
    });
  });
});
