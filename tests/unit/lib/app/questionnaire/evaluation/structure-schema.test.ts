import { describe, expect, it } from 'vitest';

import {
  MAX_EVAL_SECTIONS,
  MAX_EVAL_QUESTIONS_PER_SECTION,
  MAX_EVAL_TOPICS,
  MAX_EVAL_TOPICS_PER_QUESTION,
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

/**
 * The routing overlay's contract (F17.34).
 *
 * `versionStructureSchema` has two jobs, and they pull in different directions: it validates the
 * `evaluate-structure` capability's `structure` argument (an external boundary, so everything needs
 * a bound), and it parses a stored `structureSnapshot` (where a failure degrades the WHOLE snapshot
 * to null and silently switches that run's staleness derivation off). Both are asserted here.
 */
describe('versionStructureSchema — the routing overlay', () => {
  const base = { goal: 'g', audience: null, sections: [] };

  const routing = {
    enabled: true,
    maxConditionalTopics: 3,
    topics: [{ key: 't', label: 'T', phase: 'conditional', depth: 'light', questionCount: 2 }],
    conditionalQuestionCount: 2,
  };

  it('parses a structure carrying the overlay', () => {
    const parsed = versionStructureSchema.safeParse({ ...base, routing });
    expect(parsed.success).toBe(true);
  });

  it('parses a pre-F17.34 snapshot that has no overlay at all', () => {
    // The whole reason `routing` is optional: a required field here would fail every run created
    // before the overlay existed, and `parseStructureSnapshot` degrades a failure to null.
    const parsed = versionStructureSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('routing');
  });

  it('accepts a phase this build does not know, rather than failing the whole snapshot', () => {
    // `phase` is a string, not a z.enum, precisely so a renamed phase costs one field's meaning
    // instead of a run's entire staleness derivation.
    const parsed = versionStructureSchema.safeParse({
      ...base,
      routing: { ...routing, topics: [{ ...routing.topics[0], phase: 'some_future_phase' }] },
    });
    expect(parsed.success).toBe(true);
  });

  it('bounds the topic roster', () => {
    const tooMany = Array.from({ length: MAX_EVAL_TOPICS + 1 }, (_, i) => ({
      key: `t${i}`,
      label: 'T',
      phase: 'core',
      depth: 'full',
      questionCount: 0,
    }));
    expect(
      versionStructureSchema.safeParse({ ...base, routing: { ...routing, topics: tooMany } })
        .success
    ).toBe(false);
  });

  it('bounds how many topics one question may name', () => {
    const question = {
      key: 'q',
      prompt: 'p',
      type: 'free_text',
      required: false,
      topicKeys: Array.from({ length: MAX_EVAL_TOPICS_PER_QUESTION + 1 }, (_, i) => `t${i}`),
    };
    expect(
      versionStructureSchema.safeParse({
        ...base,
        sections: [{ title: 'S', questions: [question] }],
      }).success
    ).toBe(false);
  });

  it('rejects an overlay missing its counts', () => {
    const { conditionalQuestionCount: _drop, ...incomplete } = routing;
    expect(versionStructureSchema.safeParse({ ...base, routing: incomplete }).success).toBe(false);
  });
});
