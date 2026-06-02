import { describe, it, expect } from 'vitest';

import {
  updateVersionMetaSchema,
  updateVersionStatusSchema,
  createSectionSchema,
  updateSectionSchema,
  reorderSchema,
  createQuestionSchema,
  updateQuestionSchema,
} from '@/lib/app/questionnaire/authoring/schemas';

/**
 * Request-body contract for the authoring mutation surface (F2.1 / PR2).
 *
 * Each schema accepts a well-formed body and rejects the malformed/empty ones the
 * route relies on it to catch (so handlers never see partial junk). `typeConfig`
 * is `unknown` here by design — its per-type validation is covered separately.
 */
describe('updateVersionMetaSchema', () => {
  it('accepts a goal-only edit', () => {
    expect(updateVersionMetaSchema.safeParse({ goal: 'Understand churn' }).success).toBe(true);
  });

  it('accepts clearing a field with null', () => {
    expect(updateVersionMetaSchema.safeParse({ goal: null }).success).toBe(true);
  });

  it('accepts a partial audience', () => {
    expect(updateVersionMetaSchema.safeParse({ audience: { role: 'patient' } }).success).toBe(true);
  });

  it('rejects an empty body (no field to update)', () => {
    expect(updateVersionMetaSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a provenance field smuggled from the client', () => {
    const res = updateVersionMetaSchema.safeParse({ goal: 'x', goalProvenance: 'inferred' });
    // Unknown keys are stripped, not stored — provenance is server-derived.
    expect(res.success).toBe(true);
    expect(res.success && 'goalProvenance' in res.data).toBe(false);
  });
});

describe('updateVersionStatusSchema', () => {
  it('accepts a known status', () => {
    expect(updateVersionStatusSchema.safeParse({ status: 'launched' }).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(updateVersionStatusSchema.safeParse({ status: 'published' }).success).toBe(false);
  });
});

describe('createSectionSchema', () => {
  it('accepts a titled section', () => {
    expect(createSectionSchema.safeParse({ title: 'About you' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(createSectionSchema.safeParse({ title: '' }).success).toBe(false);
  });
});

describe('updateSectionSchema', () => {
  it('rejects an empty patch', () => {
    expect(updateSectionSchema.safeParse({}).success).toBe(false);
  });
});

describe('reorderSchema', () => {
  it('accepts a non-empty id list', () => {
    expect(reorderSchema.safeParse({ order: ['a', 'b'] }).success).toBe(true);
  });

  it('rejects an empty order', () => {
    expect(reorderSchema.safeParse({ order: [] }).success).toBe(false);
  });
});

describe('createQuestionSchema', () => {
  it('accepts a typed question', () => {
    expect(
      createQuestionSchema.safeParse({ prompt: 'Do you smoke?', type: 'boolean' }).success
    ).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(createQuestionSchema.safeParse({ prompt: 'x', type: 'paragraph' }).success).toBe(false);
  });

  it('rejects a non-positive weight', () => {
    expect(
      createQuestionSchema.safeParse({ prompt: 'x', type: 'free_text', weight: 0 }).success
    ).toBe(false);
  });
});

describe('updateQuestionSchema', () => {
  it('accepts a move (sectionId + ordinal)', () => {
    expect(updateQuestionSchema.safeParse({ sectionId: 'sec_1', ordinal: 2 }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(updateQuestionSchema.safeParse({}).success).toBe(false);
  });
});
