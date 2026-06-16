import { describe, expect, it } from 'vitest';

import { validateAnswerValue } from '@/lib/app/questionnaire/extraction/answer-value';
import { choices } from '@/tests/unit/lib/app/questionnaire/extraction/_fixtures';

describe('validateAnswerValue — free_text', () => {
  it('accepts a non-empty string', () => {
    expect(validateAnswerValue('free_text', 'hello', null)).toEqual({ ok: true, value: 'hello' });
  });
  it('rejects an empty / whitespace string', () => {
    expect(validateAnswerValue('free_text', '   ', null).ok).toBe(false);
  });
  it('rejects a non-string', () => {
    expect(validateAnswerValue('free_text', 42, null).ok).toBe(false);
  });
});

describe('validateAnswerValue — single_choice', () => {
  const cfg = choices('red', 'green', 'blue');

  it('accepts a value that is one of the choices', () => {
    expect(validateAnswerValue('single_choice', 'green', cfg)).toEqual({
      ok: true,
      value: 'green',
    });
  });
  it('trims surrounding whitespace before the membership check and stores trimmed', () => {
    expect(validateAnswerValue('single_choice', '  green  ', cfg)).toEqual({
      ok: true,
      value: 'green',
    });
  });
  it('rejects a value not among the choices', () => {
    const r = validateAnswerValue('single_choice', 'purple', cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toMatch(/not one of the slot's choices/);
  });
  it('resolves the human LABEL to the canonical slug (the model often emits the label)', () => {
    // `choices('red', ...)` mirrors labels as the upper-cased slug → label "GREEN".
    expect(validateAnswerValue('single_choice', 'GREEN', cfg)).toEqual({
      ok: true,
      value: 'green',
    });
  });
  it('resolves case-insensitively and normalises to the stored slug', () => {
    const named = {
      choices: [
        { value: 'eng', label: 'Engineering' },
        { value: 'ops', label: 'Operations' },
      ],
    };
    expect(validateAnswerValue('single_choice', 'engineering', named)).toEqual({
      ok: true,
      value: 'eng',
    });
    expect(validateAnswerValue('single_choice', 'Engineering', named)).toEqual({
      ok: true,
      value: 'eng',
    });
    expect(validateAnswerValue('single_choice', 'ENG', named)).toEqual({ ok: true, value: 'eng' });
  });
  it('an exact value wins a normalised collision with another choice’s label', () => {
    // Choice A's label ("B") normalises to the same key as Choice B's value ("b"). The resolver
    // maps labels first then values, so the exact value must win — "b" resolves to B, not A. This
    // pins the documented two-pass ordering so a one-line reorder regression is caught.
    const colliding = {
      choices: [
        { value: 'a', label: 'B' },
        { value: 'b', label: 'X' },
      ],
    };
    expect(validateAnswerValue('single_choice', 'b', colliding)).toEqual({ ok: true, value: 'b' });
    // Typing the colliding label "B" also resolves to the value 'b' (value beats label on a tie).
    expect(validateAnswerValue('single_choice', 'B', colliding)).toEqual({ ok: true, value: 'b' });
  });

  it('accepts an off-list value when allowOther is set', () => {
    expect(validateAnswerValue('single_choice', 'purple', { ...cfg, allowOther: true }).ok).toBe(
      true
    );
  });
  it('accepts any string when the config is unreadable (defensive null-config path)', () => {
    // A config that won't parse into choices → membership is unconstrained rather
    // than rejecting every answer.
    expect(validateAnswerValue('single_choice', 'anything', null)).toEqual({
      ok: true,
      value: 'anything',
    });
    expect(validateAnswerValue('single_choice', 'anything', { not: 'a choice config' }).ok).toBe(
      true
    );
  });
  it('rejects a non-string', () => {
    expect(validateAnswerValue('single_choice', ['green'], cfg).ok).toBe(false);
  });
});

describe('validateAnswerValue — multi_choice', () => {
  const cfg = choices('a', 'b', 'c');

  it('accepts an array of valid choices and de-duplicates', () => {
    expect(validateAnswerValue('multi_choice', ['a', 'b', 'a'], cfg)).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
  });
  it('rejects when any member is off-list', () => {
    expect(validateAnswerValue('multi_choice', ['a', 'z'], cfg).ok).toBe(false);
  });
  it('resolves member labels/casing to canonical slugs and de-duplicates', () => {
    // labels mirror upper-cased slugs → 'A','B'. 'A' (label) and 'a' (slug) both resolve to 'a'.
    expect(validateAnswerValue('multi_choice', ['A', 'a', 'B'], cfg)).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
  });
  it('accepts off-list members when allowOther is set', () => {
    expect(validateAnswerValue('multi_choice', ['a', 'z'], { ...cfg, allowOther: true })).toEqual({
      ok: true,
      value: ['a', 'z'],
    });
  });
  it('rejects an empty array', () => {
    expect(validateAnswerValue('multi_choice', [], cfg).ok).toBe(false);
  });
  it('rejects a non-array', () => {
    expect(validateAnswerValue('multi_choice', 'a', cfg).ok).toBe(false);
  });
});

describe('validateAnswerValue — likert', () => {
  const cfg = { min: 1, max: 5 };

  it('accepts an integer within the scale', () => {
    expect(validateAnswerValue('likert', 3, cfg)).toEqual({ ok: true, value: 3 });
  });
  it('coerces a numeric string', () => {
    expect(validateAnswerValue('likert', '4', cfg)).toEqual({ ok: true, value: 4 });
  });
  it('rejects a value outside the scale', () => {
    expect(validateAnswerValue('likert', 6, cfg).ok).toBe(false);
  });
  it('rejects a non-integer', () => {
    expect(validateAnswerValue('likert', 2.5, cfg).ok).toBe(false);
  });
  it('does NOT coerce empty string / null / boolean to 0 on a min:0 scale', () => {
    // A 0-based scale is legal config; the value coercion must still reject
    // non-numeric junk rather than recording a fabricated 0.
    const zeroBased = { min: 0, max: 5 };
    expect(validateAnswerValue('likert', '', zeroBased).ok).toBe(false);
    expect(validateAnswerValue('likert', null, zeroBased).ok).toBe(false);
    expect(validateAnswerValue('likert', false, zeroBased).ok).toBe(false);
  });
});

describe('validateAnswerValue — numeric', () => {
  it('accepts any finite number with no bounds', () => {
    expect(validateAnswerValue('numeric', 42, null)).toEqual({ ok: true, value: 42 });
  });
  it('honours min/max bounds from config', () => {
    const cfg = { min: 0, max: 100 };
    expect(validateAnswerValue('numeric', 150, cfg).ok).toBe(false);
    expect(validateAnswerValue('numeric', -1, cfg).ok).toBe(false);
    expect(validateAnswerValue('numeric', 50, cfg).ok).toBe(true);
  });
  it('coerces a numeric string but rejects non-numeric junk', () => {
    expect(validateAnswerValue('numeric', '34', null)).toEqual({ ok: true, value: 34 });
    // The crux: with no bounds, these must NOT coerce to 0/1 — they are dropped.
    expect(validateAnswerValue('numeric', '', null).ok).toBe(false);
    expect(validateAnswerValue('numeric', null, null).ok).toBe(false);
    expect(validateAnswerValue('numeric', true, null).ok).toBe(false);
    expect(validateAnswerValue('numeric', [], null).ok).toBe(false);
  });
  it('rejects a non-number', () => {
    expect(validateAnswerValue('numeric', 'lots', null).ok).toBe(false);
  });
});

describe('validateAnswerValue — date', () => {
  it('accepts an ISO date', () => {
    expect(validateAnswerValue('date', '2026-06-04', null)).toEqual({
      ok: true,
      value: '2026-06-04',
    });
  });
  it('accepts an ISO datetime', () => {
    expect(validateAnswerValue('date', '2026-06-04T10:30:00Z', null).ok).toBe(true);
  });
  it('rejects a non-ISO string', () => {
    expect(validateAnswerValue('date', 'June 4th', null).ok).toBe(false);
  });
});

describe('validateAnswerValue — boolean', () => {
  it('accepts a real boolean', () => {
    expect(validateAnswerValue('boolean', true, null)).toEqual({ ok: true, value: true });
  });
  it('coerces yes/no strings', () => {
    expect(validateAnswerValue('boolean', 'yes', null)).toEqual({ ok: true, value: true });
    expect(validateAnswerValue('boolean', 'No', null)).toEqual({ ok: true, value: false });
  });
  it('rejects an unrecognised string', () => {
    expect(validateAnswerValue('boolean', 'maybe', null).ok).toBe(false);
  });
});
