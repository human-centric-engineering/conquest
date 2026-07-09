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
