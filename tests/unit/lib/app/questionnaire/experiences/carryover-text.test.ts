import { describe, it, expect } from 'vitest';

import {
  fillPromptText,
  fillText,
  valueToText,
} from '@/lib/app/questionnaire/experiences/carryover/text';
import type { CarryOverFill } from '@/lib/app/questionnaire/experiences/run/types';

function fill(overrides: Partial<CarryOverFill> = {}): CarryOverFill {
  return {
    key: 'k',
    name: 'Name',
    theme: null,
    paraphrase: null,
    value: null,
    confidence: null,
    ...overrides,
  };
}

/**
 * These functions decide what a routing rule compares against and what an LLM actually reads. A
 * naive `String(value)` renders an object as `[object Object]`, which in a prompt silently replaces
 * a real answer with a token that means nothing — and the model has no way to know something was
 * lost. That is the regression this file exists to prevent.
 */
describe('valueToText', () => {
  it('renders primitives directly', () => {
    expect(valueToText('hello')).toBe('hello');
    expect(valueToText(42)).toBe('42');
    expect(valueToText(0)).toBe('0');
    expect(valueToText(true)).toBe('true');
    expect(valueToText(false)).toBe('false');
  });

  it('renders null and undefined as empty', () => {
    expect(valueToText(null)).toBe('');
    expect(valueToText(undefined)).toBe('');
  });

  it('joins arrays so multi-choice answers read naturally', () => {
    expect(valueToText(['onboarding', 'pricing'])).toBe('onboarding, pricing');
  });

  it('drops empty members when joining rather than leaving stray commas', () => {
    expect(valueToText(['a', '', null, 'b'])).toBe('a, b');
  });

  it('NEVER renders an object as [object Object]', () => {
    // The whole point of this module. A structured answer must reach the model as something it can
    // read, not as a token that silently stands in for lost information.
    const rendered = valueToText({ role: 'CTO', team: 12 });
    expect(rendered).not.toContain('[object Object]');
    expect(rendered).toContain('CTO');
    expect(rendered).toContain('12');
  });

  it('renders nested arrays of objects without losing content', () => {
    const rendered = valueToText([{ a: 1 }, { b: 2 }]);
    expect(rendered).not.toContain('[object Object]');
    expect(rendered).toContain('1');
    expect(rendered).toContain('2');
  });

  it('returns empty rather than throwing on an unserialisable value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(valueToText(cyclic)).toBe('');
  });
});

describe('fillText', () => {
  it('prefers the structured value — a rule author means the answer, not its rendering', () => {
    expect(fillText(fill({ value: 'yes', paraphrase: 'they agreed enthusiastically' }))).toBe(
      'yes'
    );
  });

  it('falls back to the paraphrase when there is no structured value', () => {
    expect(fillText(fill({ value: null, paraphrase: 'they agreed' }))).toBe('they agreed');
  });

  it('falls back to the paraphrase when the value renders empty', () => {
    expect(fillText(fill({ value: [], paraphrase: 'nothing selected' }))).toBe('nothing selected');
  });

  it('returns empty when there is neither', () => {
    expect(fillText(fill())).toBe('');
  });
});

describe('fillPromptText', () => {
  it('prefers the PARAPHRASE — prose gives a model more to work with than a raw value', () => {
    // The inverse of `fillText`'s preference, and deliberately so: rules want the value, prompts
    // want the respondent's own words.
    expect(
      fillPromptText(
        fill({ value: 'standups', paraphrase: 'they coordinate via weekly standups' }),
        100
      )
    ).toBe('they coordinate via weekly standups');
  });

  it('falls back to the rendered value when there is no paraphrase', () => {
    expect(fillPromptText(fill({ value: ['a', 'b'] }), 100)).toBe('a, b');
  });

  it('ignores a whitespace-only paraphrase', () => {
    expect(fillPromptText(fill({ value: 'real', paraphrase: '   ' }), 100)).toBe('real');
  });

  it('truncates to the character budget', () => {
    expect(fillPromptText(fill({ paraphrase: 'x'.repeat(500) }), 100)).toHaveLength(100);
  });

  it('renders an object-valued fill readably in a prompt', () => {
    const rendered = fillPromptText(fill({ value: { headcount: 500 } }), 200);
    expect(rendered).not.toContain('[object Object]');
    expect(rendered).toContain('500');
  });
});
