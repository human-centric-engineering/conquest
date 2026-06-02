import { describe, it, expect } from 'vitest';

import { validateTypeConfig } from '@/lib/app/questionnaire/authoring/type-config-schema';

/**
 * Boundary contract for `typeConfig` per question type (F2.1 / PR2).
 *
 * The admin's hand-edited config is pinned tightly here (the extractor's output is
 * validated loosely upstream). Each type: a valid config parses; every malformed
 * shape the UI could send is rejected. Config-less types reject populated config;
 * config-optional types accept an absent value.
 */
describe('validateTypeConfig — choice types', () => {
  for (const type of ['single_choice', 'multi_choice'] as const) {
    it(`${type}: accepts ≥2 distinct choices`, () => {
      const res = validateTypeConfig(type, {
        choices: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        allowOther: true,
      });
      expect(res.ok).toBe(true);
    });

    it(`${type}: rejects fewer than 2 choices`, () => {
      const res = validateTypeConfig(type, { choices: [{ value: 'a', label: 'A' }] });
      expect(res.ok).toBe(false);
    });

    it(`${type}: rejects duplicate choice values`, () => {
      const res = validateTypeConfig(type, {
        choices: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'Again' },
        ],
      });
      expect(res.ok).toBe(false);
    });

    it(`${type}: rejects a missing config`, () => {
      expect(validateTypeConfig(type, undefined).ok).toBe(false);
      expect(validateTypeConfig(type, null).ok).toBe(false);
    });
  }
});

describe('validateTypeConfig — likert', () => {
  it('accepts a bounded scale with labels', () => {
    const res = validateTypeConfig('likert', { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' });
    expect(res.ok).toBe(true);
  });

  it('rejects max ≤ min', () => {
    expect(validateTypeConfig('likert', { min: 5, max: 5 }).ok).toBe(false);
    expect(validateTypeConfig('likert', { min: 5, max: 1 }).ok).toBe(false);
  });

  it('rejects non-integer bounds', () => {
    expect(validateTypeConfig('likert', { min: 1, max: 5.5 }).ok).toBe(false);
  });
});

describe('validateTypeConfig — numeric', () => {
  it('accepts coherent optional bounds', () => {
    expect(validateTypeConfig('numeric', { min: 0, max: 100, step: 5, unit: 'kg' }).ok).toBe(true);
  });

  it('accepts an absent config (treated as empty)', () => {
    expect(validateTypeConfig('numeric', undefined).ok).toBe(true);
  });

  it('rejects max < min', () => {
    expect(validateTypeConfig('numeric', { min: 10, max: 1 }).ok).toBe(false);
  });

  it('rejects a non-positive step', () => {
    expect(validateTypeConfig('numeric', { step: 0 }).ok).toBe(false);
  });
});

describe('validateTypeConfig — boolean', () => {
  it('accepts optional labels (extractor shape)', () => {
    expect(validateTypeConfig('boolean', { trueLabel: 'Yes', falseLabel: 'No' }).ok).toBe(true);
  });

  it('accepts an absent config', () => {
    expect(validateTypeConfig('boolean', undefined).ok).toBe(true);
  });
});

describe('validateTypeConfig — config-less types', () => {
  for (const type of ['free_text', 'date'] as const) {
    it(`${type}: normalises absent/empty config to null`, () => {
      const absent = validateTypeConfig(type, undefined);
      const empty = validateTypeConfig(type, {});
      expect(absent).toEqual({ ok: true, value: null });
      expect(empty).toEqual({ ok: true, value: null });
    });

    it(`${type}: rejects a populated config`, () => {
      expect(validateTypeConfig(type, { choices: [] }).ok).toBe(false);
    });
  }
});
