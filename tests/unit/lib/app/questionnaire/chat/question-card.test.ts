/**
 * question-card — the decision and payload (P18 phase 3).
 *
 * The card replaces prose with the question's REAL answer control. The properties that matter are
 * the ones that decide whether a respondent can answer at all:
 *   1. it never appears for a question that can't render a control (a dead end with no way to reply);
 *   2. it never appears for free text (nothing to render — the wording is the instrument);
 *   3. it stays behind the version gate, including the last-resort path.
 *
 * @see lib/app/questionnaire/chat/question-card.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildQuestionCard,
  canRenderAnswerControl,
  shouldShowQuestionCard,
} from '@/lib/app/questionnaire/chat/question-card';

const CHOICES = {
  choices: [
    { value: 'a', label: 'Very easy' },
    { value: 'b', label: 'Very hard' },
  ],
};
const LIKERT = { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Extremely' };

const base = {
  fidelityEnabled: true,
  level: 'must_ask' as const,
  type: 'likert' as const,
  typeConfig: LIKERT,
  isReask: false,
};

describe('canRenderAnswerControl', () => {
  it('accepts typed questions with a usable config', () => {
    expect(canRenderAnswerControl('single_choice', CHOICES)).toBe(true);
    expect(canRenderAnswerControl('multi_choice', CHOICES)).toBe(true);
    expect(canRenderAnswerControl('likert', LIKERT)).toBe(true);
    expect(
      canRenderAnswerControl('matrix', { rows: [{ key: 'r', label: 'R' }], scale: LIKERT })
    ).toBe(true);
  });

  it('accepts numeric, date and boolean, which need no config', () => {
    for (const type of ['numeric', 'date', 'boolean'] as const) {
      expect(canRenderAnswerControl(type, null)).toBe(true);
    }
  });

  it('rejects free text — there is no control to render', () => {
    expect(canRenderAnswerControl('free_text', null)).toBe(false);
  });

  it('rejects a typed question whose config cannot produce a control', () => {
    // Rendering an empty radio group would be a dead end: the card would ask a question the
    // respondent has no way to answer, and the composer is hidden behind it.
    expect(canRenderAnswerControl('single_choice', null)).toBe(false);
    expect(canRenderAnswerControl('single_choice', { choices: [] })).toBe(false);
    expect(canRenderAnswerControl('likert', { min: 5, max: 1 })).toBe(false);
    expect(canRenderAnswerControl('matrix', { rows: [] })).toBe(false);
  });
});

describe('shouldShowQuestionCard', () => {
  it('shows a must_ask card for a renderable typed question', () => {
    expect(shouldShowQuestionCard(base)).toBe('must_ask');
  });

  it('never shows for free text, however the question is marked', () => {
    // An explicit product decision: at must_ask the WORDING is what is protected, and the
    // respondent answers in the ordinary composer.
    expect(shouldShowQuestionCard({ ...base, type: 'free_text', typeConfig: null })).toBeNull();
    expect(
      shouldShowQuestionCard({ ...base, type: 'free_text', typeConfig: null, isReask: true })
    ).toBeNull();
  });

  it('never shows when the control cannot be rendered', () => {
    expect(shouldShowQuestionCard({ ...base, type: 'single_choice', typeConfig: null })).toBeNull();
  });

  it('stays behind the version gate', () => {
    // Including the last-resort path — otherwise enabling nothing would still change behaviour on a
    // questionnaire whose admin never opted in.
    expect(shouldShowQuestionCard({ ...base, fidelityEnabled: false })).toBeNull();
    expect(
      shouldShowQuestionCard({
        ...base,
        fidelityEnabled: false,
        level: 'balanced',
        isReask: true,
      })
    ).toBeNull();
  });

  it('shows a last_resort card on a re-ask at an ordinary fidelity', () => {
    // The generalised "it could not be filled any other way": rather than asking a third time in
    // prose, hand over the real control.
    expect(shouldShowQuestionCard({ ...base, level: 'balanced', isReask: true })).toBe(
      'last_resort'
    );
    expect(shouldShowQuestionCard({ ...base, level: 'free', isReask: true })).toBe('last_resort');
  });

  it('does not show at an ordinary fidelity on a first ask', () => {
    expect(shouldShowQuestionCard({ ...base, level: 'balanced' })).toBeNull();
    expect(shouldShowQuestionCard({ ...base, level: 'close' })).toBeNull();
  });

  it('labels a must_ask re-ask as must_ask, not as a rescue', () => {
    // The card was always going to be shown for this question, so calling it a last resort would
    // misdescribe it — and would show the respondent apologetic copy for a deliberate design.
    expect(shouldShowQuestionCard({ ...base, isReask: true })).toBe('must_ask');
  });
});

describe('buildQuestionCard', () => {
  it('carries the stored prompt verbatim and normalises an absent config', () => {
    const card = buildQuestionCard({
      questionKey: 'workload_satisfaction',
      prompt: 'How satisfied are you with your current workload?',
      type: 'likert',
      typeConfig: undefined,
      required: true,
      reason: 'must_ask',
    });
    expect(card).toEqual({
      questionKey: 'workload_satisfaction',
      prompt: 'How satisfied are you with your current workload?',
      type: 'likert',
      typeConfig: null,
      required: true,
      reason: 'must_ask',
    });
  });
});
