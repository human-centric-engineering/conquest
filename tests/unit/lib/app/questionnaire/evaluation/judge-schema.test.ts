import { describe, expect, it } from 'vitest';

import {
  MAX_FINDINGS_PER_JUDGE,
  judgeVerdictJsonSchema,
  validateJudgeVerdict,
  coerceProposedEdit,
} from '@/lib/app/questionnaire/evaluation';

const validFinding = {
  targetKey: 'q_role',
  severity: 'major' as const,
  proposedChange: 'Split into two questions: role and tenure.',
  rationale: 'It currently asks two things at once.',
  sourceQuote: 'What is your role and how long have you held it?',
};

describe('validateJudgeVerdict', () => {
  it('accepts a well-formed verdict with findings', () => {
    const result = validateJudgeVerdict({ score: 0.6, findings: [validFinding] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(0.6);
      expect(result.value.findings).toHaveLength(1);
      expect(result.value.findings[0].targetKey).toBe('q_role');
    }
  });

  it('accepts a clean pass — empty findings array', () => {
    const result = validateJudgeVerdict({ score: 1, findings: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings).toEqual([]);
  });

  it('accepts a finding without the optional sourceQuote', () => {
    const { sourceQuote: _omit, ...noQuote } = validFinding;
    const result = validateJudgeVerdict({ score: 0.5, findings: [noQuote] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings[0].sourceQuote).toBeUndefined();
  });

  it('accepts the boundary scores 0 and 1', () => {
    expect(validateJudgeVerdict({ score: 0, findings: [] }).ok).toBe(true);
    expect(validateJudgeVerdict({ score: 1, findings: [] }).ok).toBe(true);
  });

  it('rejects a score above 1 and surfaces the issue path', () => {
    const result = validateJudgeVerdict({ score: 1.4, findings: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'score')).toBe(true);
    }
  });

  it('rejects a negative score', () => {
    expect(validateJudgeVerdict({ score: -0.1, findings: [] }).ok).toBe(false);
  });

  it('rejects a non-numeric score', () => {
    expect(validateJudgeVerdict({ score: 'high', findings: [] }).ok).toBe(false);
  });

  it('rejects an unknown severity', () => {
    const result = validateJudgeVerdict({
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
      validateJudgeVerdict({ score: 0.5, findings: [{ ...validFinding, proposedChange: '' }] }).ok
    ).toBe(false);
    expect(
      validateJudgeVerdict({ score: 0.5, findings: [{ ...validFinding, rationale: '' }] }).ok
    ).toBe(false);
    expect(
      validateJudgeVerdict({ score: 0.5, findings: [{ ...validFinding, targetKey: '' }] }).ok
    ).toBe(false);
  });

  it('rejects more findings than the per-judge cap', () => {
    const tooMany = Array.from({ length: MAX_FINDINGS_PER_JUDGE + 1 }, () => validFinding);
    const result = validateJudgeVerdict({ score: 0.5, findings: tooMany });
    expect(result.ok).toBe(false);
  });

  it('accepts exactly the per-judge cap', () => {
    const atCap = Array.from({ length: MAX_FINDINGS_PER_JUDGE }, () => validFinding);
    expect(validateJudgeVerdict({ score: 0.5, findings: atCap }).ok).toBe(true);
  });

  it('rejects a missing findings array', () => {
    expect(validateJudgeVerdict({ score: 0.5 }).ok).toBe(false);
  });

  it('exposes a JSON schema with score and findings properties', () => {
    const props = (judgeVerdictJsonSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    expect(props).toHaveProperty('score');
    expect(props).toHaveProperty('findings');
  });

  it('serialises the optional proposedEdit union into the JSON schema', () => {
    const props = (judgeVerdictJsonSchema as { properties: Record<string, unknown> }).properties;
    const items = (props.findings as { items: { properties: Record<string, unknown> } }).items;
    expect(items.properties).toHaveProperty('proposedEdit');
  });
});

describe('judgeFinding.proposedEdit (F5.3)', () => {
  const base = {
    targetKey: 'q_role',
    severity: 'minor' as const,
    proposedChange: 'Reword for clarity.',
    rationale: 'Currently ambiguous.',
  };

  it('accepts a finding carrying a replace_prompt op', () => {
    const result = validateJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, proposedEdit: { op: 'replace_prompt', prompt: 'What is your role?' } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.findings[0].proposedEdit).toEqual({
        op: 'replace_prompt',
        prompt: 'What is your role?',
      });
  });

  it('accepts a finding with no proposedEdit (prose-only)', () => {
    const result = validateJudgeVerdict({ score: 0.5, findings: [base] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings[0].proposedEdit).toBeUndefined();
  });

  it('rejects a verdict whose proposedEdit has an unknown op', () => {
    const result = validateJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, proposedEdit: { op: 'rename_everything' } }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('coerceProposedEdit', () => {
  it('returns the validated op for a well-formed edit', () => {
    expect(coerceProposedEdit({ op: 'delete_question' })).toEqual({ op: 'delete_question' });
    expect(coerceProposedEdit({ op: 'change_type', type: 'single_choice' })).toEqual({
      op: 'change_type',
      type: 'single_choice',
    });
  });

  it('degrades null / undefined / malformed ops to null (never throws)', () => {
    expect(coerceProposedEdit(null)).toBeNull();
    expect(coerceProposedEdit(undefined)).toBeNull();
    expect(coerceProposedEdit({ op: 'change_type', type: 'not_a_type' })).toBeNull();
    expect(coerceProposedEdit({ op: 'replace_prompt' })).toBeNull(); // missing prompt
    expect(coerceProposedEdit('garbage')).toBeNull();
  });

  it('keeps only the named audience sub-fields on edit_audience', () => {
    const op = coerceProposedEdit({ op: 'edit_audience', audience: { expertiseLevel: 'novice' } });
    expect(op).toEqual({ op: 'edit_audience', audience: { expertiseLevel: 'novice' } });
  });

  it('accepts the optional judge-proposed key on add_question', () => {
    const op = coerceProposedEdit({
      op: 'add_question',
      prompt: 'How would you describe your current morale at work?',
      type: 'free_text',
      key: 'work_morale',
      sectionKey: 'Background',
    });
    expect(op).toMatchObject({ op: 'add_question', key: 'work_morale', type: 'free_text' });
  });
});
