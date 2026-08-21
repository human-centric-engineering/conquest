/**
 * question-fidelity — the prompt renderer (P18 phase 2).
 *
 * The properties that matter:
 *   1. `balanced` renders NOTHING, so the assembled prompt is byte-identical to a version that
 *      never heard of the feature. This is the whole no-op guarantee.
 *   2. `must_ask` explicitly reverses the standing "don't read out the options" rule — without that
 *      reversal the model keeps honouring the earlier prohibition and asks a Likert item as an open
 *      feelings question, which is exactly the failure the feature exists to prevent.
 *   3. Free text at `must_ask` never asks for options that don't exist.
 *
 * @see lib/app/questionnaire/chat/question-fidelity.ts
 */

import { describe, it, expect } from 'vitest';

import { buildQuestionFidelityInstructions } from '@/lib/app/questionnaire/chat/question-fidelity';
import { QUESTION_FIDELITY_LEVELS } from '@/lib/app/questionnaire/types';

describe('buildQuestionFidelityInstructions', () => {
  it('renders nothing at `balanced`, whatever the question type', () => {
    // The default stop. An empty body makes `section()` collapse the block away entirely.
    for (const type of ['free_text', 'likert', 'single_choice', 'matrix'] as const) {
      expect(buildQuestionFidelityInstructions('balanced', { type })).toBe('');
    }
  });

  it('renders a non-empty clause at every other stop', () => {
    for (const level of QUESTION_FIDELITY_LEVELS) {
      const out = buildQuestionFidelityInstructions(level, { type: 'free_text' });
      if (level === 'balanced') continue;
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('gives each stop a distinct clause', () => {
    // Two stops that render the same text would be a lie told to the admin — the slider would show
    // five positions that do not behave differently.
    const rendered = QUESTION_FIDELITY_LEVELS.filter((l) => l !== 'balanced').map((l) =>
      buildQuestionFidelityInstructions(l, { type: 'likert' })
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  describe('free — permission to not ask', () => {
    it('tells the interviewer it need not put the question at all', () => {
      const out = buildQuestionFidelityInstructions('free', { type: 'free_text' });
      expect(out).toMatch(/does NOT need to be put to the respondent/i);
    });
  });

  describe('close — wording preserved, options still inferred', () => {
    it('protects the wording without demanding the options be read out', () => {
      const out = buildQuestionFidelityInstructions('close', { type: 'likert' });
      expect(out).toMatch(/stay CLOSE to the wording/i);
      // `close` still infers from natural language — only `must_ask` reverses the standing rule.
      expect(out).not.toMatch(/present them WITH the question/i);
    });
  });

  describe('must_ask', () => {
    it('demands the verbatim wording and overrides the open-question rules', () => {
      const out = buildQuestionFidelityInstructions('must_ask', { type: 'free_text' });
      expect(out).toMatch(/exactly as written/i);
      expect(out).toMatch(/OVERRIDES/);
    });

    it('reverses the "do not read out the options" rule for a typed question', () => {
      for (const type of [
        'single_choice',
        'multi_choice',
        'likert',
        'matrix',
        'boolean',
      ] as const) {
        const out = buildQuestionFidelityInstructions('must_ask', { type });
        expect(out).toMatch(/present them WITH the question/i);
        expect(out).toMatch(/earlier rule against it does not apply/i);
      }
    });

    it('does not mention options for a free-text question', () => {
      // There is nothing to render; the protected thing is the wording.
      const out = buildQuestionFidelityInstructions('must_ask', { type: 'free_text' });
      expect(out).not.toMatch(/present them WITH the question/i);
      expect(out).toMatch(/no options to present/i);
    });

    it('suppresses the read-out when a real answer control is rendered alongside', () => {
      // The in-chat question card renders the actual radio group / scale. Reciting the options in
      // prose underneath it is duplication the respondent has to reconcile.
      const out = buildQuestionFidelityInstructions('must_ask', {
        type: 'likert',
        answerControlShown: true,
      });
      expect(out).toMatch(/exactly as written/i);
      expect(out).not.toMatch(/present them WITH the question/i);
    });

    it('still demands verbatim wording when the control is shown', () => {
      const out = buildQuestionFidelityInstructions('must_ask', {
        type: 'single_choice',
        answerControlShown: true,
      });
      expect(out).toMatch(/do not paraphrase it/i);
    });

    it('says nothing about options for numeric and date questions', () => {
      // These have no fixed option set to present, but they are not free text either — neither
      // clause applies.
      for (const type of ['numeric', 'date'] as const) {
        const out = buildQuestionFidelityInstructions('must_ask', { type });
        expect(out).not.toMatch(/present them WITH the question/i);
        expect(out).not.toMatch(/no options to present/i);
      }
    });
  });
});
