/**
 * formatSlotAnswer — slot-aware answer formatter (F7.4).
 *
 * Pins the choice key→label mapping (single + multi), the boolean custom-label path, the
 * fall-throughs to plain value formatting (free-text, numeric, missing config, unknown key),
 * and the nullish em-dash.
 *
 * @see lib/app/questionnaire/panel/format-slot-answer.ts
 */

import { describe, it, expect } from 'vitest';

import { formatSlotAnswer } from '@/lib/app/questionnaire/panel/format-slot-answer';

const CHOICES = {
  choices: [
    { value: 'opt_a', label: 'Very satisfied' },
    { value: 'opt_b', label: 'Neutral' },
    { value: 'opt_c', label: 'Dissatisfied' },
  ],
};

describe('formatSlotAnswer', () => {
  it('maps a single_choice key to its label', () => {
    expect(formatSlotAnswer('single_choice', CHOICES, 'opt_a')).toBe('Very satisfied');
  });

  it('maps each multi_choice key to its label, comma-joined', () => {
    expect(formatSlotAnswer('multi_choice', CHOICES, ['opt_a', 'opt_c'])).toBe(
      'Very satisfied, Dissatisfied'
    );
  });

  it('falls back to the raw value when a choice key is not in the option list', () => {
    // A stale/free-typed value never renders blank — it shows verbatim.
    expect(formatSlotAnswer('single_choice', CHOICES, 'opt_z')).toBe('opt_z');
    expect(formatSlotAnswer('multi_choice', CHOICES, ['opt_a', 'opt_z'])).toBe(
      'Very satisfied, opt_z'
    );
  });

  it('falls back to value formatting when the choice config is unreadable', () => {
    expect(formatSlotAnswer('single_choice', null, 'opt_a')).toBe('opt_a');
    expect(formatSlotAnswer('single_choice', { choices: [] }, 'opt_a')).toBe('opt_a');
  });

  it('uses configured boolean labels, else Yes/No', () => {
    expect(formatSlotAnswer('boolean', { trueLabel: 'Agree', falseLabel: 'Disagree' }, true)).toBe(
      'Agree'
    );
    expect(formatSlotAnswer('boolean', { trueLabel: 'Agree', falseLabel: 'Disagree' }, false)).toBe(
      'Disagree'
    );
    expect(formatSlotAnswer('boolean', null, true)).toBe('Yes');
  });

  it('passes free-text and numeric values through unchanged', () => {
    expect(formatSlotAnswer('free_text', null, 'Hello there')).toBe('Hello there');
    expect(formatSlotAnswer('numeric', { min: 0, max: 10 }, 7)).toBe('7');
  });

  describe('likert', () => {
    const LIKERT = {
      min: 1,
      max: 5,
      labels: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'],
    };

    it('renders the per-point label for the answer value', () => {
      expect(formatSlotAnswer('likert', LIKERT, 1)).toBe('Very dissatisfied');
      expect(formatSlotAnswer('likert', LIKERT, 3)).toBe('Neutral');
      expect(formatSlotAnswer('likert', LIKERT, 5)).toBe('Very satisfied');
    });

    it('honours a non-1 minimum when indexing labels', () => {
      const bipolar = { min: -1, max: 1, labels: ['Against', 'Neutral', 'For'] };
      expect(formatSlotAnswer('likert', bipolar, -1)).toBe('Against');
      expect(formatSlotAnswer('likert', bipolar, 1)).toBe('For');
    });

    it('falls back to the number for an unlabelled scale or out-of-range value', () => {
      expect(formatSlotAnswer('likert', { min: 1, max: 5 }, 3)).toBe('3');
      expect(formatSlotAnswer('likert', LIKERT, 9)).toBe('9');
    });
  });

  it('renders an em-dash for a nullish answer regardless of type', () => {
    expect(formatSlotAnswer('single_choice', CHOICES, null)).toBe('—');
    expect(formatSlotAnswer('multi_choice', CHOICES, [])).toBe('—');
    expect(formatSlotAnswer('free_text', null, undefined)).toBe('—');
  });

  it('formats non-choice array, boolean, bigint, and object values via the plain fallback', () => {
    // These value types land on a slot type with no key→label map, so they fall through to
    // formatValue's own branches (the renderer the on-screen panel shares).
    expect(formatSlotAnswer('free_text', null, ['Alpha', 'Beta'])).toBe('Alpha, Beta');
    expect(formatSlotAnswer('free_text', null, [])).toBe('—');
    // A boolean on a non-boolean slot has no custom labels, so it reads Yes/No.
    expect(formatSlotAnswer('free_text', null, true)).toBe('Yes');
    expect(formatSlotAnswer('free_text', null, false)).toBe('No');
    expect(formatSlotAnswer('numeric', null, 42n)).toBe('42');
    expect(formatSlotAnswer('free_text', null, { tier: 'gold' })).toBe('{"tier":"gold"}');
  });

  it('renders an em-dash for a blank free-text string', () => {
    expect(formatSlotAnswer('free_text', null, '   ')).toBe('—');
  });
});
