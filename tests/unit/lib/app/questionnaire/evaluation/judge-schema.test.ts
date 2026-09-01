import { describe, expect, it } from 'vitest';

import {
  MAX_FINDINGS_PER_JUDGE,
  judgeVerdictJsonSchema,
  validateJudgeVerdict,
  coerceProposedEdit,
} from '@/lib/app/questionnaire/evaluation';
import { SECTION_TITLE_MAX } from '@/lib/app/questionnaire/types';
import { createSectionSchema } from '@/lib/app/questionnaire/authoring/schemas';

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

describe('coerceProposedEdit — split_question', () => {
  // The Clarity judge has always been TOLD to propose splits: its rubric scores questions on being
  // "single-barrelled" and its prompt gives "Split into: 'What is your role?' and 'How long have
  // you been in it?'" as the model example of a good finding. It had no op to say it with, so every
  // such finding landed prose-only and the admin retyped it in the editor. This op is that gap.
  it('accepts a well-formed split', () => {
    expect(
      coerceProposedEdit({
        op: 'split_question',
        prompt: 'Who is the designated safeguarding lead this year?',
        secondPrompt: 'When did they last complete advanced training?',
        secondKey: 'lead_last_advanced_training',
      })
    ).toEqual({
      op: 'split_question',
      prompt: 'Who is the designated safeguarding lead this year?',
      secondPrompt: 'When did they last complete advanced training?',
      secondKey: 'lead_last_advanced_training',
    });
  });

  it('accepts a split without a proposed key — apply slugifies the second prompt instead', () => {
    const op = coerceProposedEdit({
      op: 'split_question',
      prompt: 'What is your role?',
      secondPrompt: 'How long have you been in it?',
    });
    expect(op).toMatchObject({ op: 'split_question' });
    expect(op && 'secondKey' in op ? op.secondKey : undefined).toBeUndefined();
  });

  // A half-formed split is the dangerous shape: applied, it would blank one of the two questions.
  // Degrading to null makes the finding prose-only, which is the safe failure.
  it('degrades a split missing its second half to null', () => {
    expect(coerceProposedEdit({ op: 'split_question', prompt: 'What is your role?' })).toBeNull();
    expect(
      coerceProposedEdit({ op: 'split_question', secondPrompt: 'How long have you been in it?' })
    ).toBeNull();
    expect(coerceProposedEdit({ op: 'split_question', prompt: 'a', secondPrompt: '' })).toBeNull();
  });
});

describe('section titles fit every field that refers to them', () => {
  /**
   * A title exactly as long as authoring allows. The point of these tests is that this string can
   * make the round trip: it can be created, so every schema that names it afterwards has to hold
   * it. The caps used to be written independently, and a title of this length was creatable,
   * referable as `sectionKey`, and NOT referable as `targetKey`.
   */
  const maxTitle = 'S'.repeat(SECTION_TITLE_MAX);

  const base = {
    severity: 'minor' as const,
    proposedChange: 'Add a question on support.',
    rationale: 'Gap against the goal.',
  };

  it('lets authoring create a title of exactly the maximum', () => {
    expect(createSectionSchema.safeParse({ title: maxTitle }).success).toBe(true);
  });

  it('refuses one character more, so the reference caps below are never the binding limit', () => {
    // The direction matters. Refusing at creation keeps an over-long title out of an unbounded
    // Postgres column; refusing only at reference time means it is already persisted and the
    // finding that mentions it silently degrades to prose.
    expect(createSectionSchema.safeParse({ title: `${maxTitle}X` }).success).toBe(false);
  });

  it('accepts a maximal title as an add_question sectionKey', () => {
    const result = validateJudgeVerdict({
      score: 0.5,
      findings: [
        {
          ...base,
          targetKey: 'goal',
          proposedEdit: {
            op: 'add_question',
            prompt: 'How supported did you feel?',
            type: 'free_text',
            sectionKey: maxTitle,
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a maximal title inside a section: targetKey, prefix and all', () => {
    // The regression this pins. `targetKey` carries `section:<title>`, so a flat cap shared with
    // `sectionKey` left it eight characters short of the title it was supposed to address.
    const result = validateJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, targetKey: `section:${maxTitle}` }],
    });
    expect(result.ok).toBe(true);
  });

  it('still bounds a targetKey that is not a section reference', () => {
    // The cap is a real bound, not a formality: it is derived from the title limit rather than
    // removed, so an unbounded key still fails.
    const result = validateJudgeVerdict({
      score: 0.5,
      findings: [{ ...base, targetKey: 'q_'.repeat(SECTION_TITLE_MAX) }],
    });
    expect(result.ok).toBe(false);
  });
});
