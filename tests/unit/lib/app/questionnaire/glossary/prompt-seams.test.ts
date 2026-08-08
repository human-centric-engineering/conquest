/**
 * Glossary prompt seams — cross-cutting unit tests (P16).
 *
 * The glossary is threaded into four prompt builders. Each was changed the same way, so the
 * invariants are pinned here once rather than scattered across four files:
 *
 *   1. **Zero cost when absent.** No glossary → the prompt is byte-identical to what it was
 *      before this feature existed. This is the property most likely to regress silently: a
 *      builder that emitted an empty `<glossary>` block would charge every turn of every
 *      questionnaire for an empty instruction.
 *   2. **Present when supplied.** The definitions reach the model, numbered where the admin kept
 *      several senses.
 *   3. The contradiction detector additionally gains a RULE — the guard against the
 *      same-term-two-senses false positive — and only when definitions are actually present.
 *
 * @see lib/app/questionnaire/glossary/injection.ts
 */

import { describe, it, expect } from 'vitest';

import { buildStreamingQuestionPrompt } from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
import { buildAnswerExtractionPrompt } from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { buildContradictionDetectionPrompt } from '@/lib/app/questionnaire/contradiction/detection-prompt';
import { buildRefinementPrompt } from '@/lib/app/questionnaire/refinement/refinement-prompt';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

const GLOSSARY = [
  '- higher self: The observing, values-led part of you.',
  '- ego: (1) The constructed self that seeks approval; (2) the Jungian conscious centre.',
];

/** Flatten a built prompt to one searchable string. */
function text(messages: LlmMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* 1. Interviewer phraser                                                     */
/* -------------------------------------------------------------------------- */

function questionInput(glossary?: string[]) {
  return {
    prompt: 'How connected do you feel to your higher self?',
    type: 'free_text' as const,
    recentMessages: [],
    lastUserMessage: '',
    isOpening: true,
    isReask: false,
    isTransition: false,
    questionsAsked: 0,
    ...(glossary ? { glossary } : {}),
  };
}

describe('interviewer phraser', () => {
  it('emits no glossary block when none is supplied', () => {
    expect(text(buildStreamingQuestionPrompt(questionInput()))).not.toContain('<glossary>');
  });

  it('emits no glossary block for an empty array', () => {
    expect(text(buildStreamingQuestionPrompt(questionInput([])))).not.toContain('<glossary>');
  });

  it('is byte-identical with an absent vs empty glossary', () => {
    expect(text(buildStreamingQuestionPrompt(questionInput([])))).toBe(
      text(buildStreamingQuestionPrompt(questionInput()))
    );
  });

  it('includes the definitions and the do-not-recite instruction when supplied', () => {
    const built = text(buildStreamingQuestionPrompt(questionInput(GLOSSARY)));
    expect(built).toContain('<glossary>');
    expect(built).toContain('The observing, values-led part of you.');
    expect(built).toContain('Do NOT read these');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Answer extraction                                                       */
/* -------------------------------------------------------------------------- */

function extractionContext(glossary?: string[]) {
  return {
    activeQuestionKey: 'q1',
    candidateSlots: [
      {
        key: 'q1',
        type: 'free_text' as const,
        typeConfig: null,
        prompt: 'How connected do you feel to your higher self?',
        required: false,
      },
    ],
    answered: [],
    userMessage: 'Very connected, most days.',
    sessionId: 'sess-1',
    ...(glossary ? { glossary } : {}),
  };
}

describe('answer extraction', () => {
  it('emits no glossary block when none is supplied', () => {
    expect(text(buildAnswerExtractionPrompt(extractionContext()))).not.toContain('glossary_rules');
  });

  it('is byte-identical with an absent vs empty glossary', () => {
    expect(text(buildAnswerExtractionPrompt(extractionContext([])))).toBe(
      text(buildAnswerExtractionPrompt(extractionContext()))
    );
  });

  it('includes the definitions when supplied', () => {
    const built = text(buildAnswerExtractionPrompt(extractionContext(GLOSSARY)));
    expect(built).toContain('<glossary_rules>');
    expect(built).toContain('the Jungian conscious centre');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Contradiction detection — the highest-value seam                        */
/* -------------------------------------------------------------------------- */

function contradictionContext(glossary?: string[]) {
  return {
    slots: [
      {
        key: 'q1',
        type: 'free_text' as const,
        typeConfig: null,
        prompt: 'Is your ego healthy?',
        required: false,
      },
      {
        key: 'q2',
        type: 'free_text' as const,
        typeConfig: null,
        prompt: 'Does your ego hinder?',
        required: false,
      },
    ],
    answers: [
      { slotKey: 'q1', value: 'Yes, healthy.', confidence: 0.9 },
      { slotKey: 'q2', value: 'Yes, it gets in the way.', confidence: 0.9 },
    ],
    mode: 'flag' as const,
    windowN: 0,
    sessionId: 'sess-1',
    ...(glossary ? { glossary } : {}),
  };
}

describe('contradiction detection', () => {
  it('emits no glossary block and no glossary rule when none is supplied', () => {
    const built = text(buildContradictionDetectionPrompt(contradictionContext()));
    expect(built).not.toContain('higher self');
    expect(built).not.toContain('DEFINED meanings');
  });

  it('is byte-identical with an absent vs empty glossary', () => {
    expect(text(buildContradictionDetectionPrompt(contradictionContext([])))).toBe(
      text(buildContradictionDetectionPrompt(contradictionContext()))
    );
  });

  it('adds the same-term-two-senses guard only when definitions are present', () => {
    // Without this rule the detector raises "your ego is healthy" vs "your ego hinders you" with
    // the respondent as a self-contradiction, when the questionnaire accepts both readings.
    const built = text(buildContradictionDetectionPrompt(contradictionContext(GLOSSARY)));
    expect(built).toContain('DEFINED meanings');
    expect(built).toContain('are NOT a contradiction');
    expect(built).toContain('The constructed self that seeks approval');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Refinement                                                              */
/* -------------------------------------------------------------------------- */

function refinementContext(glossary?: string[]) {
  return {
    slots: [
      {
        key: 'q1',
        type: 'free_text' as const,
        typeConfig: null,
        prompt: 'Describe your ego.',
        required: false,
      },
    ],
    existingAnswers: [
      { slotKey: 'q1', value: 'It gets in the way.', provenance: 'direct' as const },
    ],
    userMessage: 'Actually I meant something else by ego.',
    sessionId: 'sess-1',
    ...(glossary ? { glossary } : {}),
  };
}

describe('answer refinement', () => {
  it('emits no glossary block when none is supplied', () => {
    expect(text(buildRefinementPrompt(refinementContext()))).not.toContain('<glossary>');
  });

  it('is byte-identical with an absent vs empty glossary', () => {
    expect(text(buildRefinementPrompt(refinementContext([])))).toBe(
      text(buildRefinementPrompt(refinementContext()))
    );
  });

  it('includes the definitions when supplied', () => {
    const built = text(buildRefinementPrompt(refinementContext(GLOSSARY)));
    expect(built).toContain('<glossary>');
    expect(built).toContain('The observing, values-led part of you.');
  });
});
