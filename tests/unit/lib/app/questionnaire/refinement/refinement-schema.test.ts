import { describe, expect, it } from 'vitest';

import { REFINEMENT_ACTIONS, REFINEMENT_SOURCES } from '@/lib/app/questionnaire/refinement/types';
import {
  refinementJsonSchema,
  validateRefinement,
} from '@/lib/app/questionnaire/refinement/refinement-schema';

describe('validateRefinement', () => {
  it('accepts a well-formed refinements payload and returns the typed value', () => {
    const result = validateRefinement({
      refinements: [
        {
          slotKey: 'children_count',
          action: 'refine',
          newValue: 2,
          rationale: 'earlier said none, now confirms two',
          source: 'contradiction',
          confidence: 0.9,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.refinements).toHaveLength(1);
      expect(result.value.refinements[0]?.slotKey).toBe('children_count');
    }
  });

  it('accepts an empty refinements array (nothing to change)', () => {
    const result = validateRefinement({ refinements: [] });
    expect(result.ok).toBe(true);
  });

  it('accepts a leave decision without a newValue (optional)', () => {
    const result = validateRefinement({
      refinements: [
        {
          slotKey: 'a',
          action: 'leave',
          rationale: 'unchanged',
          source: 'clarification',
          confidence: 0.5,
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('reports the field path when slotKey is empty', () => {
    const result = validateRefinement({
      refinements: [
        { slotKey: '', action: 'refine', rationale: 'x', source: 'clarification', confidence: 0.5 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'refinements.0.slotKey')).toBe(true);
    }
  });

  it('reports the field path when rationale is missing', () => {
    const result = validateRefinement({
      refinements: [{ slotKey: 'a', action: 'refine', source: 'clarification', confidence: 0.5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'refinements.0.rationale')).toBe(true);
    }
  });

  it('rejects a confidence outside 0–1', () => {
    const result = validateRefinement({
      refinements: [
        { slotKey: 'a', action: 'refine', rationale: 'x', source: 'clarification', confidence: 2 },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an action outside the vocabulary', () => {
    const result = validateRefinement({
      refinements: [
        {
          slotKey: 'a',
          action: 'delete',
          rationale: 'x',
          source: 'clarification',
          confidence: 0.5,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a source outside the vocabulary', () => {
    const result = validateRefinement({
      refinements: [
        { slotKey: 'a', action: 'refine', rationale: 'x', source: 'guesswork', confidence: 0.5 },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts each action and source label', () => {
    for (const action of REFINEMENT_ACTIONS) {
      for (const source of REFINEMENT_SOURCES) {
        const result = validateRefinement({
          refinements: [
            { slotKey: 'a', action, newValue: 'v', rationale: 'x', source, confidence: 0.5 },
          ],
        });
        expect(result.ok, `${action}/${source} should validate`).toBe(true);
      }
    }
  });
});

describe('refinementJsonSchema', () => {
  it('is computed at module load and exposes the refinements array', () => {
    expect(refinementJsonSchema).toBeTypeOf('object');
    const props = (refinementJsonSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('refinements');
  });
});
