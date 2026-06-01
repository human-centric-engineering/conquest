import { describe, it, expect } from 'vitest';

import {
  extractionSchema,
  extractionJsonSchema,
  validateExtraction,
  type ExtractionResult,
} from '@/lib/app/questionnaire/ingestion/extraction-schema';

/**
 * Contract tests for the extractor's structured-output schema (F1.1 / PR2).
 *
 * Pure, zero-mock. These pin the LLM↔app boundary: a valid extraction parses to
 * the typed shape, and every malformed shape the model can plausibly emit is
 * rejected with an `issues` path precise enough to drive the repair retry. The
 * JSON-schema serialisation (fed to a provider `responseFormat`) is asserted to
 * carry exactly the required top-level keys.
 */

function validResult(): ExtractionResult {
  return {
    sections: [
      { ordinal: 0, title: 'About you', description: 'Basic details' },
      { ordinal: 1, title: 'Health history' },
    ],
    questions: [
      {
        sectionOrdinal: 0,
        key: 'full_name',
        prompt: 'What is your full name?',
        suggestedType: 'free_text',
        extractionConfidence: 0.95,
      },
      {
        sectionOrdinal: 1,
        key: 'smoker',
        prompt: 'Do you smoke?',
        guidelines: 'Yes or no',
        rationale: 'Risk factor',
        suggestedType: 'boolean',
        suggestedTypeConfig: { trueLabel: 'Yes', falseLabel: 'No' },
        extractionConfidence: 0.8,
        sourceQuote: 'Smoker? Y/N',
      },
    ],
    inferredGoal: 'Collect a basic patient profile',
    inferredAudience: { role: 'patient', expertiseLevel: 'novice', locale: 'en' },
    changes: [
      {
        changeType: 'correct_spelling',
        targetEntityType: 'question',
        sourceQuote: 'naem',
        beforeJson: { prompt: 'What is your naem?' },
        afterJson: { prompt: 'What is your full name?' },
        rationale: 'Fixed typo',
        confidence: 0.99,
      },
    ],
  };
}

describe('extractionSchema — valid inputs', () => {
  it('parses a fully-populated extraction to the typed shape', () => {
    const result = validateExtraction(validResult());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questions).toHaveLength(2);
    expect(result.value.questions[0].suggestedType).toBe('free_text');
    expect(result.value.questions[1].suggestedTypeConfig).toEqual({
      trueLabel: 'Yes',
      falseLabel: 'No',
    });
    expect(result.value.inferredAudience?.expertiseLevel).toBe('novice');
    expect(result.value.changes[0].changeType).toBe('correct_spelling');
  });

  it('accepts empty section/question/change arrays and omitted optionals', () => {
    const result = validateExtraction({ sections: [], questions: [], changes: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inferredGoal).toBeUndefined();
    expect(result.value.inferredAudience).toBeUndefined();
  });

  it('accepts arbitrary JSON in before/after and typeConfig (object, array, scalar, null)', () => {
    const base = validResult();
    base.changes = [
      { changeType: 'augment_question', targetEntityType: 'question', afterJson: ['a', 'b'] },
      { changeType: 'merge_questions', targetEntityType: 'question', beforeJson: 'raw text' },
      { changeType: 'split_question', targetEntityType: 'question', afterJson: 42 },
      { changeType: 'prune_question', targetEntityType: 'question', afterJson: null },
    ];
    base.questions[0].suggestedTypeConfig = { choices: ['x', 'y'], min: 1, nested: { a: 1 } };
    expect(validateExtraction(base).ok).toBe(true);
  });

  it('accepts every canonical question type and change type', () => {
    const base = validResult();
    base.questions = (
      [
        'free_text',
        'single_choice',
        'multi_choice',
        'likert',
        'numeric',
        'date',
        'boolean',
      ] as const
    ).map((t, i) => ({
      sectionOrdinal: 0,
      key: `q_${t}`,
      prompt: `Prompt ${i}`,
      suggestedType: t,
      extractionConfidence: 0.5,
    }));
    expect(validateExtraction(base).ok).toBe(true);
  });
});

describe('extractionSchema — rejections with precise issue paths', () => {
  function firstIssuePath(value: unknown): string {
    const result = validateExtraction(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    return result.issues[0].path.join('.');
  }

  it('rejects a missing required top-level key', () => {
    const { questions, ...withoutQuestions } = validResult();
    void questions;
    const result = validateExtraction(withoutQuestions);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.join('.') === 'questions')).toBe(true);
  });

  it('rejects an unknown question type at the offending path', () => {
    const bad = validResult();
    (bad.questions[0] as { suggestedType: string }).suggestedType = 'paragraph';
    expect(firstIssuePath(bad)).toBe('questions.0.suggestedType');
  });

  it('rejects extractionConfidence out of the 0..1 range', () => {
    const high = validResult();
    high.questions[0].extractionConfidence = 1.5;
    expect(firstIssuePath(high)).toBe('questions.0.extractionConfidence');

    const low = validResult();
    low.questions[0].extractionConfidence = -0.1;
    expect(firstIssuePath(low)).toBe('questions.0.extractionConfidence');
  });

  it('rejects a missing required extractionConfidence', () => {
    const bad = validResult();
    delete (bad.questions[0] as { extractionConfidence?: number }).extractionConfidence;
    expect(firstIssuePath(bad)).toBe('questions.0.extractionConfidence');
  });

  it('rejects an empty section title', () => {
    const bad = validResult();
    bad.sections[0].title = '';
    expect(firstIssuePath(bad)).toBe('sections.0.title');
  });

  it('rejects an unknown changeType and an unknown targetEntityType', () => {
    const badType = validResult();
    (badType.changes[0] as { changeType: string }).changeType = 'reword';
    expect(firstIssuePath(badType)).toBe('changes.0.changeType');

    const badTarget = validResult();
    (badTarget.changes[0] as { targetEntityType: string }).targetEntityType = 'slot';
    expect(firstIssuePath(badTarget)).toBe('changes.0.targetEntityType');
  });

  it('rejects an invalid inferred audience field', () => {
    const badEnum = validResult();
    badEnum.inferredAudience = { expertiseLevel: 'guru' as never };
    expect(firstIssuePath(badEnum)).toBe('inferredAudience.expertiseLevel');

    const badDuration = validResult();
    badDuration.inferredAudience = { estimatedDurationMinutes: -5 };
    expect(firstIssuePath(badDuration)).toBe('inferredAudience.estimatedDurationMinutes');
  });

  it('rejects a non-object root', () => {
    expect(validateExtraction(null).ok).toBe(false);
    expect(validateExtraction('a string').ok).toBe(false);
    expect(validateExtraction([]).ok).toBe(false);
  });
});

describe('extractionJsonSchema serialisation', () => {
  it('is an object schema requiring exactly the three non-optional top-level keys', () => {
    expect(extractionJsonSchema.type).toBe('object');
    expect(extractionJsonSchema.required).toEqual(['sections', 'questions', 'changes']);
  });

  it('exposes all five top-level properties (incl. the optional inferred fields)', () => {
    const properties = extractionJsonSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(
      ['changes', 'inferredAudience', 'inferredGoal', 'questions', 'sections'].sort()
    );
  });

  it('stays in lockstep with the Zod schema it serialises', () => {
    // Guards against the JSON schema and the Zod schema drifting apart.
    expect(Object.keys((extractionJsonSchema.properties as object) ?? {}).sort()).toEqual(
      Object.keys(extractionSchema.shape).sort()
    );
  });
});
