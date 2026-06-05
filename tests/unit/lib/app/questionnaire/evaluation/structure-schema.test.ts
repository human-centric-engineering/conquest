import { describe, expect, it } from 'vitest';

import {
  MAX_EVAL_SECTIONS,
  MAX_EVAL_QUESTIONS_PER_SECTION,
  parseAudienceShape,
  versionStructureSchema,
} from '@/lib/app/questionnaire/evaluation';

describe('parseAudienceShape', () => {
  it('returns a typed audience for a well-formed value', () => {
    const result = parseAudienceShape({
      description: 'New hires',
      role: 'Engineer',
      expertiseLevel: 'intermediate',
      estimatedDurationMinutes: 10,
      sensitivity: 'low',
    });
    expect(result).not.toBeNull();
    expect(result?.role).toBe('Engineer');
    expect(result?.expertiseLevel).toBe('intermediate');
  });

  it('returns an empty object for {} (all fields optional)', () => {
    expect(parseAudienceShape({})).toEqual({});
  });

  it('returns null for a malformed audience (bad enum) rather than throwing', () => {
    expect(parseAudienceShape({ expertiseLevel: 'guru' })).toBeNull();
  });

  it('returns null for a non-object', () => {
    expect(parseAudienceShape('expert')).toBeNull();
    expect(parseAudienceShape(42)).toBeNull();
    expect(parseAudienceShape(null)).toBeNull();
  });

  it('rejects a bad sensitivity enum', () => {
    expect(parseAudienceShape({ sensitivity: 'extreme' })).toBeNull();
  });
});

describe('versionStructureSchema', () => {
  const base = {
    goal: 'Understand onboarding.',
    audience: { role: 'Engineer' },
    sections: [
      {
        title: 'Background',
        questions: [{ key: 'q1', prompt: 'Role?', type: 'free_text', required: true }],
      },
    ],
  };

  it('accepts a well-formed structure', () => {
    expect(versionStructureSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a null goal and null audience', () => {
    const result = versionStructureSchema.safeParse({ ...base, goal: null, audience: null });
    expect(result.success).toBe(true);
  });

  it('accepts an empty sections array', () => {
    expect(versionStructureSchema.safeParse({ ...base, sections: [] }).success).toBe(true);
  });

  it('rejects a question with an empty key', () => {
    const result = versionStructureSchema.safeParse({
      ...base,
      sections: [
        { title: 'S', questions: [{ key: '', prompt: 'p', type: 'free_text', required: true }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more sections than the cap', () => {
    const sections = Array.from({ length: MAX_EVAL_SECTIONS + 1 }, (_, i) => ({
      title: `S${i}`,
      questions: [],
    }));
    expect(versionStructureSchema.safeParse({ ...base, sections }).success).toBe(false);
  });

  it('rejects more questions in a section than the cap', () => {
    const questions = Array.from({ length: MAX_EVAL_QUESTIONS_PER_SECTION + 1 }, (_, i) => ({
      key: `q${i}`,
      prompt: 'p',
      type: 'free_text',
      required: false,
    }));
    const result = versionStructureSchema.safeParse({
      ...base,
      sections: [{ title: 'S', questions }],
    });
    expect(result.success).toBe(false);
  });
});
