import { describe, expect, it } from 'vitest';

import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import {
  answerExtractionJsonSchema,
  validateAnswerExtraction,
} from '@/lib/app/questionnaire/extraction/extraction-schema';

describe('validateAnswerExtraction', () => {
  it('accepts a well-formed answers payload and returns the typed value', () => {
    const result = validateAnswerExtraction({
      answers: [
        {
          slotKey: 'age',
          value: 34,
          confidence: 0.9,
          provenance: 'direct',
          rationale: 'stated',
          sourceQuote: "I'm 34",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answers).toHaveLength(1);
      expect(result.value.answers[0]?.slotKey).toBe('age');
    }
  });

  it('accepts an empty answers array (message answered nothing)', () => {
    const result = validateAnswerExtraction({ answers: [] });
    expect(result.ok).toBe(true);
  });

  it('reports the field path when slotKey is missing', () => {
    const result = validateAnswerExtraction({
      answers: [{ value: 'x', confidence: 0.5, provenance: 'direct', rationale: 'r' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'answers.0.slotKey')).toBe(true);
    }
  });

  it('rejects a confidence outside 0–1', () => {
    const result = validateAnswerExtraction({
      answers: [
        { slotKey: 'a', value: 'x', confidence: 1.5, provenance: 'direct', rationale: 'r' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a provenance the extractor is not allowed to emit (refined)', () => {
    const result = validateAnswerExtraction({
      answers: [
        { slotKey: 'a', value: 'x', confidence: 0.5, provenance: 'refined', rationale: 'r' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts each emittable provenance label', () => {
    for (const provenance of EXTRACTOR_EMITTED_PROVENANCES) {
      const result = validateAnswerExtraction({
        answers: [{ slotKey: 'a', value: 'x', confidence: 0.5, provenance, rationale: 'r' }],
      });
      expect(result.ok, `${provenance} should validate`).toBe(true);
    }
  });
});

describe('answerExtractionJsonSchema', () => {
  it('is computed at module load and leaves value open (any JSON)', () => {
    expect(answerExtractionJsonSchema).toBeTypeOf('object');
    const props = (answerExtractionJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(props).toHaveProperty('answers');
  });
});
