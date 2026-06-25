import { describe, it, expect } from 'vitest';

import {
  validateTypeConfig,
  hasCompleteLikertLabels,
  typeConfigSchemaFor,
  defaultTypeConfig,
} from '@/lib/app/questionnaire/authoring/type-config-schema';

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
  const fivePoint = ['Very low', 'Low', 'Neutral', 'High', 'Very high'];

  it('accepts a bounded scale with one label per point', () => {
    const res = validateTypeConfig('likert', { min: 1, max: 5, labels: fivePoint });
    expect(res.ok).toBe(true);
  });

  it('requires labels — rejects a bounds-only config', () => {
    // Write boundary now demands per-point labels (a numeric rating must use the numeric type).
    expect(validateTypeConfig('likert', { min: 1, max: 5 }).ok).toBe(false);
    expect(
      validateTypeConfig('likert', { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' }).ok
    ).toBe(false);
  });

  it('rejects a labels array of the wrong length', () => {
    expect(validateTypeConfig('likert', { min: 1, max: 5, labels: ['a', 'b', 'c'] }).ok).toBe(
      false
    );
    expect(validateTypeConfig('likert', { min: 1, max: 3, labels: fivePoint }).ok).toBe(false);
  });

  it('rejects a blank label', () => {
    expect(validateTypeConfig('likert', { min: 1, max: 3, labels: ['Low', '', 'High'] }).ok).toBe(
      false
    );
  });

  it('rejects max ≤ min', () => {
    expect(validateTypeConfig('likert', { min: 5, max: 5, labels: ['a'] }).ok).toBe(false);
    expect(validateTypeConfig('likert', { min: 5, max: 1, labels: ['a'] }).ok).toBe(false);
  });

  it('rejects non-integer bounds', () => {
    expect(validateTypeConfig('likert', { min: 1, max: 5.5, labels: fivePoint }).ok).toBe(false);
  });

  it('read schema stays lenient — a legacy bounds-only config still parses (for answer validation)', () => {
    // Bound-readers, scoring and answer validation must not reject a pre-backfill row.
    expect(typeConfigSchemaFor('likert').safeParse({ min: 1, max: 5 }).success).toBe(true);
    expect(
      typeConfigSchemaFor('likert').safeParse({ min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' })
        .success
    ).toBe(true);
  });
});

describe('defaultTypeConfig', () => {
  it('seeds a choice type with two distinct options that validate', () => {
    for (const type of ['single_choice', 'multi_choice'] as const) {
      const cfg = defaultTypeConfig(type);
      expect(validateTypeConfig(type, cfg).ok).toBe(true);
    }
  });

  it('seeds a likert with a fully-labelled scale that satisfies the write schema', () => {
    const cfg = defaultTypeConfig('likert') as { min: number; max: number; labels: string[] };
    expect(cfg).toMatchObject({ min: 1, max: 5 });
    expect(cfg.labels).toHaveLength(5);
    // Crucially, the default must pass the strict write schema (the editor relies on this).
    expect(hasCompleteLikertLabels(cfg)).toBe(true);
    expect(validateTypeConfig('likert', cfg).ok).toBe(true);
  });

  it('seeds numeric/boolean as an empty (valid) config and config-less types as null', () => {
    expect(defaultTypeConfig('numeric')).toEqual({});
    expect(defaultTypeConfig('boolean')).toEqual({});
    expect(defaultTypeConfig('free_text')).toBeNull();
    expect(defaultTypeConfig('date')).toBeNull();
  });
});

describe('hasCompleteLikertLabels', () => {
  it('is true only for a fully-labelled scale', () => {
    expect(hasCompleteLikertLabels({ min: 1, max: 3, labels: ['Low', 'Mid', 'High'] })).toBe(true);
  });

  it('is false for a bounds-only, wrong-length, or non-likert config', () => {
    expect(hasCompleteLikertLabels({ min: 1, max: 5 })).toBe(false);
    expect(hasCompleteLikertLabels({ min: 1, max: 5, labels: ['Low', 'High'] })).toBe(false);
    expect(hasCompleteLikertLabels({ choices: [] })).toBe(false);
    expect(hasCompleteLikertLabels(null)).toBe(false);
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
