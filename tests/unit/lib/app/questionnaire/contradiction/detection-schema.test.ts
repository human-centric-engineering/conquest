import { describe, expect, it } from 'vitest';

import { CONTRADICTION_SEVERITIES } from '@/lib/app/questionnaire/contradiction/types';
import {
  contradictionDetectionJsonSchema,
  validateContradictionDetection,
} from '@/lib/app/questionnaire/contradiction/detection-schema';

describe('validateContradictionDetection', () => {
  it('accepts a well-formed contradictions payload and returns the typed value', () => {
    const result = validateContradictionDetection({
      contradictions: [
        {
          slotKeys: ['has_children', 'children_count'],
          explanation: 'said no children but later gave a count of two',
          severity: 'high',
          confidence: 0.9,
          suggestedProbe: 'Earlier you said no children — do you have two?',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contradictions).toHaveLength(1);
      expect(result.value.contradictions[0]?.slotKeys).toEqual(['has_children', 'children_count']);
    }
  });

  it('accepts an empty contradictions array (no conflicts found)', () => {
    const result = validateContradictionDetection({ contradictions: [] });
    expect(result.ok).toBe(true);
  });

  it('accepts a contradiction without a suggestedProbe (optional)', () => {
    const result = validateContradictionDetection({
      contradictions: [
        { slotKeys: ['a', 'b'], explanation: 'x', severity: 'low', confidence: 0.5 },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('reports the field path when slotKeys is empty', () => {
    const result = validateContradictionDetection({
      contradictions: [{ slotKeys: [], explanation: 'x', severity: 'low', confidence: 0.5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'contradictions.0.slotKeys')).toBe(
        true
      );
    }
  });

  it('reports the field path when explanation is missing', () => {
    const result = validateContradictionDetection({
      contradictions: [{ slotKeys: ['a', 'b'], severity: 'low', confidence: 0.5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'contradictions.0.explanation')).toBe(
        true
      );
    }
  });

  it('rejects a confidence outside 0–1', () => {
    const result = validateContradictionDetection({
      contradictions: [{ slotKeys: ['a', 'b'], explanation: 'x', severity: 'low', confidence: 2 }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a severity outside the vocabulary', () => {
    const result = validateContradictionDetection({
      contradictions: [
        { slotKeys: ['a', 'b'], explanation: 'x', severity: 'critical', confidence: 0.5 },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts each severity label', () => {
    for (const severity of CONTRADICTION_SEVERITIES) {
      const result = validateContradictionDetection({
        contradictions: [{ slotKeys: ['a', 'b'], explanation: 'x', severity, confidence: 0.5 }],
      });
      expect(result.ok, `${severity} should validate`).toBe(true);
    }
  });
});

describe('contradictionDetectionJsonSchema', () => {
  it('is computed at module load and exposes the contradictions array', () => {
    expect(contradictionDetectionJsonSchema).toBeTypeOf('object');
    const props = (contradictionDetectionJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(props).toHaveProperty('contradictions');
  });
});
