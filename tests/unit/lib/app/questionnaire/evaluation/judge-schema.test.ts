import { describe, expect, it } from 'vitest';

import {
  MAX_FINDINGS_PER_JUDGE,
  judgeVerdictJsonSchema,
  validateJudgeVerdict,
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
});
