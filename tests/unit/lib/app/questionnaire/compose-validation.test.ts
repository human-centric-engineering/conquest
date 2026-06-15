/**
 * Unit tests for the generative-authoring validation layer: the structured-output
 * adapters (`compose-schema.ts`) and the request-body schemas (`compose-input.ts`).
 * Pure Zod — no provider, no DB.
 */

import { describe, it, expect } from 'vitest';

import {
  toExtractionData,
  validateComposeStructure,
  validateComposeOutline,
  validateRefineStructure,
} from '@/lib/app/questionnaire/ingestion/compose-schema';
import {
  composeRequestSchema,
  refineRequestSchema,
  MAX_BRIEF_CHARS,
} from '@/app/api/v1/app/questionnaires/_lib/compose-input';

const VALID_STRUCTURE = {
  sections: [{ ordinal: 0, title: 'Background' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'name',
      prompt: 'Your name?',
      suggestedType: 'free_text',
      extractionConfidence: 0.9,
    },
  ],
  inferredGoal: 'Goal',
  inferredAudience: { role: 'manager' },
};

describe('compose-schema validation', () => {
  it('accepts a well-formed structure', () => {
    const result = validateComposeStructure(VALID_STRUCTURE);
    expect(result.ok).toBe(true);
  });

  it('rejects a question missing the required prompt', () => {
    const bad = {
      sections: [{ ordinal: 0, title: 'S' }],
      questions: [
        { sectionOrdinal: 0, key: 'q', suggestedType: 'free_text', extractionConfidence: 1 },
      ],
    };
    const result = validateComposeStructure(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects an outline with no sections', () => {
    expect(validateComposeOutline({ sections: [] }).ok).toBe(false);
  });

  it('rejects a refine output missing the summary', () => {
    expect(validateRefineStructure({ structure: VALID_STRUCTURE }).ok).toBe(false);
  });

  it('requires a non-empty summary on a refine output', () => {
    expect(validateRefineStructure({ structure: VALID_STRUCTURE, summary: '' }).ok).toBe(false);
    expect(validateRefineStructure({ structure: VALID_STRUCTURE, summary: 'ok' }).ok).toBe(true);
  });
});

describe('toExtractionData', () => {
  it('always injects an empty change log (generation has no before-state)', () => {
    const result = validateComposeStructure(VALID_STRUCTURE);
    if (!result.ok) throw new Error('fixture should validate');
    const data = toExtractionData(result.value);
    expect(data.changes).toEqual([]);
    expect(data.inferredGoal).toBe('Goal');
    expect(data.inferredAudience).toEqual({ role: 'manager' });
  });

  it('omits inferred goal/audience when absent rather than emitting nulls', () => {
    const result = validateComposeStructure({
      sections: VALID_STRUCTURE.sections,
      questions: VALID_STRUCTURE.questions,
    });
    if (!result.ok) throw new Error('fixture should validate');
    const data = toExtractionData(result.value);
    expect(data).not.toHaveProperty('inferredGoal');
    expect(data).not.toHaveProperty('inferredAudience');
  });
});

describe('composeRequestSchema', () => {
  it('accepts a brief and trims it', () => {
    const parsed = composeRequestSchema.safeParse({ brief: '  build me a survey  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.brief).toBe('build me a survey');
  });

  it('rejects an empty brief', () => {
    expect(composeRequestSchema.safeParse({ brief: '   ' }).success).toBe(false);
  });

  it('rejects a brief over the length cap', () => {
    expect(composeRequestSchema.safeParse({ brief: 'x'.repeat(MAX_BRIEF_CHARS + 1) }).success).toBe(
      false
    );
  });

  it('passes optional title/goal/audience through', () => {
    const parsed = composeRequestSchema.safeParse({
      brief: 'b',
      title: 'My survey',
      goal: 'measure churn',
      audience: { role: 'CSM' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('refineRequestSchema', () => {
  it('accepts a non-empty instruction', () => {
    expect(refineRequestSchema.safeParse({ instruction: 'make it shorter' }).success).toBe(true);
  });

  it('rejects an empty instruction', () => {
    expect(refineRequestSchema.safeParse({ instruction: '' }).success).toBe(false);
  });
});
