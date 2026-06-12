/**
 * Data-slots schemas — unit tests
 *
 * Verifies Zod accept/reject boundaries for all schemas in the data-slots
 * feature.  No mocking — every schema is a pure Zod definition.
 *
 * Test Coverage:
 * - nameSchema (via generatedDataSlotSchema): length limits, word-count cap,
 *   trimming, empty-string rejection
 * - generatedDataSlotSchema: valid slot, missing fields, confidence range,
 *   default values, questionKeys
 * - dataSlotGenerationOutputSchema: valid payload, too many slots, empty array
 * - questionForGenerationSchema: required fields, optional sectionTitle
 * - dataSlotStructureSchema: goal nullish, questions min(1)
 * - createDataSlotSchema: valid body, weight constraints
 * - updateDataSlotSchema: single-field patch, empty-body rejection, all-field
 *   patch
 * - saveDataSlotsSchema: empty slots array, max-60 boundary
 *
 * @see lib/app/questionnaire/data-slots/schemas.ts
 */

import { describe, it, expect } from 'vitest';

import {
  generatedDataSlotSchema,
  dataSlotGenerationOutputSchema,
  questionForGenerationSchema,
  dataSlotStructureSchema,
  createDataSlotSchema,
  updateDataSlotSchema,
  saveDataSlotsSchema,
} from '@/lib/app/questionnaire/data-slots/schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validGeneratedSlot = {
  name: 'Onboarding ease',
  description: 'Captures how straightforward the initial setup feels for new users.',
  theme: 'Onboarding',
  questionKeys: ['q1', 'q2'],
  confidence: 0.85,
};

const validQuestion = {
  key: 'q1',
  prompt: 'How easy was onboarding?',
  type: 'scale',
};

// ---------------------------------------------------------------------------
// generatedDataSlotSchema
// ---------------------------------------------------------------------------

describe('generatedDataSlotSchema', () => {
  describe('name (1–4 word, 1–60 char)', () => {
    it('accepts a valid 1–4-word name', () => {
      const result = generatedDataSlotSchema.parse(validGeneratedSlot);
      expect(result.name).toBe('Onboarding ease');
    });

    it('trims whitespace from the name', () => {
      const result = generatedDataSlotSchema.parse({
        ...validGeneratedSlot,
        name: '  Time to value  ',
      });
      expect(result.name).toBe('Time to value');
    });

    it('rejects an empty name', () => {
      const r = generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, name: '' });
      expect(r.success).toBe(false);
      if (!r.success) {
        const issue = r.error.issues.find((i) => i.path.includes('name'));
        expect(issue).toBeDefined();
      }
    });

    it('rejects a name that exceeds 60 characters', () => {
      const longName = 'A'.repeat(61);
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, name: longName }).success
      ).toBe(false);
    });

    it('rejects a name with more than 4 words', () => {
      const r = generatedDataSlotSchema.safeParse({
        ...validGeneratedSlot,
        name: 'One Two Three Four Five',
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        const nameIssue = r.error.issues.find((i) => i.path.includes('name'));
        expect(nameIssue?.message).toMatch(/4 words/i);
      }
    });

    it('accepts exactly 4 words', () => {
      const r = generatedDataSlotSchema.safeParse({
        ...validGeneratedSlot,
        name: 'One Two Three Four',
      });
      expect(r.success).toBe(true);
    });
  });

  describe('description (1–1000 char)', () => {
    it('accepts a non-empty description', () => {
      const result = generatedDataSlotSchema.parse(validGeneratedSlot);
      expect(result.description).toContain('Captures');
    });

    it('rejects an empty description', () => {
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, description: '' }).success
      ).toBe(false);
    });

    it('rejects a description exceeding 1000 characters', () => {
      const longDesc = 'a'.repeat(1001);
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, description: longDesc }).success
      ).toBe(false);
    });

    it('accepts a description exactly 1000 characters', () => {
      const maxDesc = 'a'.repeat(1000);
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, description: maxDesc }).success
      ).toBe(true);
    });
  });

  describe('theme', () => {
    it('rejects an empty theme', () => {
      expect(generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, theme: '' }).success).toBe(
        false
      );
    });

    it('rejects a theme exceeding 60 characters', () => {
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, theme: 'T'.repeat(61) }).success
      ).toBe(false);
    });

    it('trims the theme value', () => {
      const result = generatedDataSlotSchema.parse({
        ...validGeneratedSlot,
        theme: '  Onboarding  ',
      });
      expect(result.theme).toBe('Onboarding');
    });
  });

  describe('questionKeys', () => {
    it('defaults to an empty array when omitted', () => {
      const { questionKeys: _, ...withoutKeys } = validGeneratedSlot;
      const result = generatedDataSlotSchema.parse(withoutKeys);
      expect(result.questionKeys).toEqual([]);
    });

    it('rejects an array containing an empty-string key', () => {
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, questionKeys: [''] }).success
      ).toBe(false);
    });

    it('preserves multiple question keys', () => {
      const result = generatedDataSlotSchema.parse({
        ...validGeneratedSlot,
        questionKeys: ['q1', 'q2', 'q3'],
      });
      expect(result.questionKeys).toEqual(['q1', 'q2', 'q3']);
    });
  });

  describe('confidence', () => {
    it('defaults to 0.5 when omitted', () => {
      const { confidence: _, ...withoutConf } = validGeneratedSlot;
      const result = generatedDataSlotSchema.parse(withoutConf);
      expect(result.confidence).toBe(0.5);
    });

    it('accepts boundary values 0 and 1', () => {
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, confidence: 0 }).success
      ).toBe(true);
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, confidence: 1 }).success
      ).toBe(true);
    });

    it('rejects values outside the 0–1 range', () => {
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, confidence: -0.01 }).success
      ).toBe(false);
      expect(
        generatedDataSlotSchema.safeParse({ ...validGeneratedSlot, confidence: 1.01 }).success
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// dataSlotGenerationOutputSchema
// ---------------------------------------------------------------------------

describe('dataSlotGenerationOutputSchema', () => {
  it('accepts a valid slots array', () => {
    const result = dataSlotGenerationOutputSchema.parse({ slots: [validGeneratedSlot] });
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].name).toBe('Onboarding ease');
  });

  it('accepts an empty slots array', () => {
    const result = dataSlotGenerationOutputSchema.parse({ slots: [] });
    expect(result.slots).toEqual([]);
  });

  it('rejects more than 60 slots', () => {
    const tooMany = Array.from({ length: 61 }, (_, i) => ({
      ...validGeneratedSlot,
      name: `Slot ${i + 1}`,
    }));
    expect(dataSlotGenerationOutputSchema.safeParse({ slots: tooMany }).success).toBe(false);
  });

  it('accepts exactly 60 slots', () => {
    const exactly60 = Array.from({ length: 60 }, (_, i) => ({
      ...validGeneratedSlot,
      name: `Slot ${i + 1}`,
    }));
    expect(dataSlotGenerationOutputSchema.safeParse({ slots: exactly60 }).success).toBe(true);
  });

  it('rejects a missing slots key', () => {
    expect(dataSlotGenerationOutputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid slot inside the array', () => {
    const withBadSlot = { slots: [{ ...validGeneratedSlot, confidence: 2 }] };
    expect(dataSlotGenerationOutputSchema.safeParse(withBadSlot).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// questionForGenerationSchema
// ---------------------------------------------------------------------------

describe('questionForGenerationSchema', () => {
  it('accepts a minimal valid question', () => {
    const result = questionForGenerationSchema.parse(validQuestion);
    expect(result.key).toBe('q1');
    expect(result.type).toBe('scale');
    expect(result.sectionTitle).toBeUndefined();
  });

  it('accepts an optional sectionTitle', () => {
    const result = questionForGenerationSchema.parse({
      ...validQuestion,
      sectionTitle: 'Background',
    });
    expect(result.sectionTitle).toBe('Background');
  });

  it('rejects an empty key', () => {
    expect(questionForGenerationSchema.safeParse({ ...validQuestion, key: '' }).success).toBe(
      false
    );
  });

  it('rejects an empty prompt', () => {
    expect(questionForGenerationSchema.safeParse({ ...validQuestion, prompt: '' }).success).toBe(
      false
    );
  });

  it('rejects an empty type', () => {
    expect(questionForGenerationSchema.safeParse({ ...validQuestion, type: '' }).success).toBe(
      false
    );
  });

  it('rejects a missing required field', () => {
    const { key: _, ...withoutKey } = validQuestion;
    expect(questionForGenerationSchema.safeParse(withoutKey).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dataSlotStructureSchema
// ---------------------------------------------------------------------------

describe('dataSlotStructureSchema', () => {
  it('accepts a structure with goal and questions', () => {
    const result = dataSlotStructureSchema.parse({
      goal: 'Understand onboarding experience',
      questions: [validQuestion],
    });
    expect(result.goal).toBe('Understand onboarding experience');
    expect(result.questions).toHaveLength(1);
  });

  it('accepts a null goal (nullish)', () => {
    const result = dataSlotStructureSchema.parse({
      goal: null,
      questions: [validQuestion],
    });
    expect(result.goal).toBeNull();
  });

  it('accepts an absent goal (nullish)', () => {
    const result = dataSlotStructureSchema.parse({ questions: [validQuestion] });
    expect(result.goal).toBeUndefined();
  });

  it('accepts an optional audience field of any shape', () => {
    const result = dataSlotStructureSchema.parse({
      questions: [validQuestion],
      audience: { role: 'nurse', locale: 'en' },
    });
    expect(result.audience).toEqual({ role: 'nurse', locale: 'en' });
  });

  it('rejects an empty questions array', () => {
    expect(dataSlotStructureSchema.safeParse({ questions: [] }).success).toBe(false);
  });

  it('rejects a missing questions field', () => {
    expect(dataSlotStructureSchema.safeParse({ goal: 'Something' }).success).toBe(false);
  });

  it('rejects an invalid question inside the array', () => {
    expect(
      dataSlotStructureSchema.safeParse({ questions: [{ key: '', prompt: 'x', type: 'scale' }] })
        .success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createDataSlotSchema
// ---------------------------------------------------------------------------

describe('createDataSlotSchema', () => {
  const validCreate = {
    name: 'Time to value',
    description: 'How quickly users reach their first meaningful outcome.',
    theme: 'Value',
    questionKeys: ['q1'],
  };

  it('accepts a valid create body without weight', () => {
    const result = createDataSlotSchema.parse(validCreate);
    expect(result.name).toBe('Time to value');
    expect(result.weight).toBeUndefined();
  });

  it('accepts an explicit weight between 0 (exclusive) and 100', () => {
    const result = createDataSlotSchema.parse({ ...validCreate, weight: 50 });
    expect(result.weight).toBe(50);
  });

  it('rejects weight of 0 (must be positive)', () => {
    expect(createDataSlotSchema.safeParse({ ...validCreate, weight: 0 }).success).toBe(false);
  });

  it('rejects weight exceeding 100', () => {
    expect(createDataSlotSchema.safeParse({ ...validCreate, weight: 101 }).success).toBe(false);
  });

  it('accepts weight exactly equal to 100', () => {
    expect(createDataSlotSchema.safeParse({ ...validCreate, weight: 100 }).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(createDataSlotSchema.safeParse({ ...validCreate, name: '' }).success).toBe(false);
  });

  it('rejects a name with more than 4 words', () => {
    expect(
      createDataSlotSchema.safeParse({ ...validCreate, name: 'One Two Three Four Five' }).success
    ).toBe(false);
  });

  it('defaults questionKeys to empty array', () => {
    const { questionKeys: _, ...withoutKeys } = validCreate;
    const result = createDataSlotSchema.parse(withoutKeys);
    expect(result.questionKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateDataSlotSchema
// ---------------------------------------------------------------------------

describe('updateDataSlotSchema', () => {
  it('accepts a single-field patch (name only)', () => {
    expect(updateDataSlotSchema.safeParse({ name: 'New name' }).success).toBe(true);
  });

  it('accepts a single-field patch (theme only)', () => {
    expect(updateDataSlotSchema.safeParse({ theme: 'Growth' }).success).toBe(true);
  });

  it('accepts an all-field patch', () => {
    const r = updateDataSlotSchema.safeParse({
      name: 'Time to value',
      description: 'How quickly users reach their first meaningful outcome.',
      theme: 'Value',
      questionKeys: ['q2'],
      weight: 75,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty body (at least one field required)', () => {
    const r = updateDataSlotSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('still validates name word-count when present', () => {
    expect(updateDataSlotSchema.safeParse({ name: 'One Two Three Four Five' }).success).toBe(false);
  });

  it('still validates weight range when present', () => {
    expect(updateDataSlotSchema.safeParse({ weight: 0 }).success).toBe(false);
    expect(updateDataSlotSchema.safeParse({ weight: 101 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveDataSlotsSchema
// ---------------------------------------------------------------------------

describe('saveDataSlotsSchema', () => {
  const validSaveSlot = {
    name: 'Onboarding ease',
    description: 'Captures how straightforward the initial setup feels for new users.',
    theme: 'Onboarding',
    questionKeys: ['q1'],
  };

  it('accepts an empty slots array (admin clearing all slots)', () => {
    const result = saveDataSlotsSchema.parse({ slots: [] });
    expect(result.slots).toEqual([]);
  });

  it('accepts a valid single-slot body', () => {
    const result = saveDataSlotsSchema.parse({ slots: [validSaveSlot] });
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].name).toBe('Onboarding ease');
  });

  it('rejects more than 60 slots', () => {
    const tooMany = Array.from({ length: 61 }, (_, i) => ({
      ...validSaveSlot,
      name: `Slot ${i + 1}`,
    }));
    expect(saveDataSlotsSchema.safeParse({ slots: tooMany }).success).toBe(false);
  });

  it('accepts exactly 60 slots', () => {
    const exactly60 = Array.from({ length: 60 }, (_, i) => ({
      ...validSaveSlot,
      name: `Slot ${i + 1}`,
    }));
    expect(saveDataSlotsSchema.safeParse({ slots: exactly60 }).success).toBe(true);
  });

  it('rejects a slot with an invalid name inside the array', () => {
    const withBadSlot = {
      slots: [{ ...validSaveSlot, name: 'One Two Three Four Five' }],
    };
    expect(saveDataSlotsSchema.safeParse(withBadSlot).success).toBe(false);
  });

  it('rejects a missing slots key', () => {
    expect(saveDataSlotsSchema.safeParse({}).success).toBe(false);
  });
});
