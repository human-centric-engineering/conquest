/**
 * Unit tests for the choice-config normaliser (F1.1 follow-up).
 *
 * The normaliser is the persistence-boundary defence that turns whatever shape a
 * model emits for a choice question into the canonical `{ value, label }[]` the
 * downstream readers require. The load-bearing behaviours: string arrays are
 * coerced, half-objects are completed, colliding values are de-duped, degenerate
 * lists are left untouched, and non-choice types pass through unchanged.
 *
 * @see lib/app/questionnaire/ingestion/normalize-type-config.ts
 */

import { describe, it, expect } from 'vitest';

import { normalizeSuggestedTypeConfig } from '@/lib/app/questionnaire/ingestion/normalize-type-config';
import { readChoicesConfig } from '@/lib/app/questionnaire/form/type-config';

describe('normalizeSuggestedTypeConfig — choice coercion', () => {
  it('coerces a bare string array into {value,label} objects', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Never', 'Once or twice'],
    });
    expect(out).toEqual({
      choices: [
        { value: 'never', label: 'Never' },
        { value: 'once_or_twice', label: 'Once or twice' },
      ],
    });
  });

  it('passes a well-formed {value,label} list through unchanged', () => {
    const config = {
      choices: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    };
    expect(normalizeSuggestedTypeConfig('multi_choice', config)).toEqual(config);
  });

  it('fills a missing/empty value from the label', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: [{ label: 'Strongly agree' }, { value: '', label: 'Strongly disagree' }],
    }) as { choices: Array<{ value: string; label: string }> };
    expect(out.choices).toEqual([
      { value: 'strongly_agree', label: 'Strongly agree' },
      { value: 'strongly_disagree', label: 'Strongly disagree' },
    ]);
  });

  it('de-duplicates colliding values with a numeric suffix', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Yes', 'Yes', 'Yes'],
    }) as { choices: Array<{ value: string }> };
    expect(out.choices.map((c) => c.value)).toEqual(['yes', 'yes_2', 'yes_3']);
  });

  it('falls back to a positional value when a label has no slug-able characters', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['☑', 'Yes'],
    }) as { choices: Array<{ value: string; label: string }> };
    expect(out.choices).toEqual([
      { value: 'option_1', label: '☑' },
      { value: 'yes', label: 'Yes' },
    ]);
  });

  it('preserves allowOther when it is genuinely true', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['A', 'B'],
      allowOther: true,
    });
    expect(out).toMatchObject({ allowOther: true });
  });

  it('drops a wrongly-typed allowOther so the result still passes the choice reader', () => {
    // A model emitting allowOther:"true" (string) must not sink the whole config —
    // choicesConfigSchema would reject a non-boolean allowOther and the field would
    // render nothing. The normaliser keeps only choices + a real boolean allowOther.
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Yes', 'No'],
      allowOther: 'true',
    });
    expect(out).toEqual({
      choices: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    });
    expect(readChoicesConfig('single_choice', out)).not.toBeNull();
  });

  it('folds accents when deriving a value instead of inserting stray underscores', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Être présent', 'Élève'],
    }) as { choices: Array<{ value: string; label: string }> };
    expect(out.choices).toEqual([
      { value: 'etre_present', label: 'Être présent' },
      { value: 'eleve', label: 'Élève' },
    ]);
  });

  it('drops unusable entries (empty objects, non-string/object junk) and keeps the valid ones', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Yes', {}, { value: '', label: '  ' }, 42, null, 'No'],
    }) as { choices: Array<{ value: string; label: string }> };
    // Only the two real string options survive; the empty object, the label-less
    // object, and the non-string/object entries are all discarded.
    expect(out.choices).toEqual([
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ]);
  });

  it('derives a value from an object that supplies only a value (no label)', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: [{ value: 'Blue' }, { value: 'Green' }],
    }) as { choices: Array<{ value: string; label: string }> };
    // With no label, the given value doubles as the label and seeds the slug.
    expect(out.choices).toEqual([
      { value: 'Blue', label: 'Blue' },
      { value: 'Green', label: 'Green' },
    ]);
  });

  it('leaves a degenerate (<2 usable options) list untouched for the admin to fix', () => {
    const oneOption = { choices: ['Only me'] };
    expect(normalizeSuggestedTypeConfig('single_choice', oneOption)).toBe(oneOption);

    const allEmpty = { choices: ['', '   '] };
    expect(normalizeSuggestedTypeConfig('single_choice', allEmpty)).toBe(allEmpty);
  });

  it('returns the raw value when choices is absent or not an array', () => {
    const noChoices = { allowOther: true };
    expect(normalizeSuggestedTypeConfig('single_choice', noChoices)).toBe(noChoices);
    expect(normalizeSuggestedTypeConfig('single_choice', null)).toBeNull();
  });
});

describe('normalizeSuggestedTypeConfig — non-choice types pass through', () => {
  it('returns likert/numeric/boolean/free_text configs unchanged', () => {
    const likert = { min: 1, max: 5, labels: ['a', 'b', 'c', 'd', 'e'] };
    expect(normalizeSuggestedTypeConfig('likert', likert)).toBe(likert);

    const numeric = { min: 0, max: 10 };
    expect(normalizeSuggestedTypeConfig('numeric', numeric)).toBe(numeric);

    const boolean = { trueLabel: 'Agree', falseLabel: 'Disagree' };
    expect(normalizeSuggestedTypeConfig('boolean', boolean)).toBe(boolean);

    // A stray `choices` on a non-choice type must NOT be rewritten.
    const oddFreeText = { choices: ['x', 'y'] };
    expect(normalizeSuggestedTypeConfig('free_text', oddFreeText)).toBe(oddFreeText);
  });
});

describe('normalizeSuggestedTypeConfig — "Other" escape hatch → allowOther', () => {
  it('turns a trailing "Other" option into allowOther and drops the dead option', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Own outright', 'Renting', 'Other'],
    }) as { choices: Array<{ label: string }>; allowOther?: boolean };
    expect(out.allowOther).toBe(true);
    expect(out.choices.map((c) => c.label)).toEqual(['Own outright', 'Renting']);
  });

  it('detects "Other (please specify)" and "Something else" as escape hatches', () => {
    const specify = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['A', 'B', 'Other (please specify)'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(specify.allowOther).toBe(true);
    expect(specify.choices).toHaveLength(2);

    const somethingElse = normalizeSuggestedTypeConfig('multi_choice', {
      choices: ['A', 'B', 'Something else'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(somethingElse.allowOther).toBe(true);
    expect(somethingElse.choices).toHaveLength(2);
  });

  it('detects a bare "Please specify" option (no "Other" prefix) as an escape hatch', () => {
    // Hits the standalone /^\(?please\s+specify\)?\.?$/i branch, distinct from the
    // "Other"-anchored regex the cases above exercise.
    const bare = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['A', 'B', 'Please specify'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(bare.allowOther).toBe(true);
    expect(bare.choices).toHaveLength(2);

    const parenthesised = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['A', 'B', '(please specify)'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(parenthesised.allowOther).toBe(true);
    expect(parenthesised.choices).toHaveLength(2);
  });

  it('detects a mid-list "Prefer to self-describe" (gender-style) and drops just that option', () => {
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Male', 'Female', 'Non-binary', 'Prefer to self-describe', 'Prefer not to say'],
    }) as { choices: Array<{ label: string }>; allowOther?: boolean };
    expect(out.allowOther).toBe(true);
    // The self-describe hatch is removed; "Prefer not to say" — a real answer — stays.
    expect(out.choices.map((c) => c.label)).toEqual([
      'Male',
      'Female',
      'Non-binary',
      'Prefer not to say',
    ]);
  });

  it('does NOT treat "Prefer not to say" / "None" / "No preference" as escape hatches', () => {
    const out = normalizeSuggestedTypeConfig('multi_choice', {
      choices: ['Petrol', 'Diesel', 'No preference / open to advice'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(out.allowOther).toBeUndefined();
    expect(out.choices).toHaveLength(3);

    const preferNot = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Under £20k', 'Over £20k', 'Prefer not to say'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(preferNot.allowOther).toBeUndefined();
    expect(preferNot.choices).toHaveLength(3);
  });

  it('leaves a 2-option list untouched when dropping "Other" would fall below the floor', () => {
    // Dropping "Other" here would leave a single selectable option — worse than a dead
    // "Other" radio. Keep the list intact for the admin to fix rather than collapse it.
    const out = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Yes', 'Other'],
    }) as { choices: unknown[]; allowOther?: boolean };
    expect(out.choices).toHaveLength(2);
    expect(out.allowOther).toBeUndefined();
  });

  it('does not touch escape-hatch-looking words on non-choice types', () => {
    const freeText = { choices: ['A', 'Other'] };
    expect(normalizeSuggestedTypeConfig('free_text', freeText)).toBe(freeText);
  });
});

describe('normalizeSuggestedTypeConfig — render path recovers', () => {
  it('produces a config the choice reader accepts (the end-to-end symptom fix)', () => {
    // Before the fix, `readChoicesConfig` returned null for a string-array config,
    // so the field rendered nothing selectable. After normalisation it must parse.
    const normalized = normalizeSuggestedTypeConfig('single_choice', {
      choices: ['Days', 'Weeks', 'Months', 'Until a customer tells us'],
    });
    const read = readChoicesConfig('single_choice', normalized);
    expect(read).not.toBeNull();
    expect(read?.choices).toHaveLength(4);
    expect(read?.choices.map((c) => c.label)).toEqual([
      'Days',
      'Weeks',
      'Months',
      'Until a customer tells us',
    ]);
  });
});

describe('normalizeSuggestedTypeConfig — matrix rows', () => {
  const scale = { min: 1, max: 5, minLabel: 'Not important', maxLabel: 'Essential' };

  it('canonicalises row keys and keeps the shared scale', () => {
    const out = normalizeSuggestedTypeConfig('matrix', {
      rows: [{ label: 'Fuel efficiency' }, { label: 'Low emissions' }],
      scale,
    }) as { rows: Array<{ key: string; label: string }>; scale: unknown };
    expect(out.rows.map((r) => r.key)).toEqual(['fuel_efficiency', 'low_emissions']);
    expect(out.rows.map((r) => r.label)).toEqual(['Fuel efficiency', 'Low emissions']);
    expect(out.scale).toEqual(scale);
  });

  it('de-dupes colliding row keys with a numeric suffix', () => {
    const out = normalizeSuggestedTypeConfig('matrix', {
      rows: [
        { key: 'cost', label: 'Cost' },
        { key: 'cost', label: 'Cost (again)' },
      ],
      scale,
    }) as { rows: Array<{ key: string }> };
    const keys = out.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('emits only { rows, scale } (drops stray keys)', () => {
    const out = normalizeSuggestedTypeConfig('matrix', {
      rows: [{ key: 'a', label: 'A' }],
      scale,
      stray: 'x',
    }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['rows', 'scale']);
  });

  it('leaves a degenerate grid (no rows / no scale) untouched', () => {
    const noRows = { rows: [], scale };
    expect(normalizeSuggestedTypeConfig('matrix', noRows)).toBe(noRows);
    const noScale = { rows: [{ key: 'a', label: 'A' }] };
    expect(normalizeSuggestedTypeConfig('matrix', noScale)).toBe(noScale);
  });
});
