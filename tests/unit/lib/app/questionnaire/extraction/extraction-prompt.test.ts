import { describe, expect, it } from 'vitest';

import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import {
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { choiceSlot, ctx, slot } from '@/tests/unit/lib/app/questionnaire/extraction/_fixtures';

function userContent(messages: ReturnType<typeof buildAnswerExtractionPrompt>): string {
  const user = messages.find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

describe('buildAnswerExtractionPrompt', () => {
  it('emits a system rules message and a user message', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('lists every emittable provenance label in the system rules', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    for (const label of EXTRACTOR_EMITTED_PROVENANCES) {
      expect(system).toContain(label);
    }
    // Never offers the F4.4-only label.
    expect(system).not.toContain('refined');
  });

  it('carries the active key, candidate prompts, and the respondent message', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'name', prompt: 'What is your name?' })],
        activeQuestionKey: 'name',
        userMessage: 'I am Dana',
      })
    );
    const content = userContent(messages);
    expect(content).toContain('Active question key: name');
    expect(content).toContain('What is your name?');
    expect(content).toContain('I am Dana');
  });

  it('renders choice options for a choice slot', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [choiceSlot('colour', 'single_choice', 'red', 'blue')] })
    );
    const content = userContent(messages);
    expect(content).toContain('options:');
    expect(content).toContain('red');
    expect(content).toContain('blue');
  });

  it('includes the transcript only when recent messages are supplied', () => {
    const withTranscript = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [slot({ key: 'q1' })], recentMessages: ['earlier turn'] })
    );
    expect(userContent(withTranscript)).toContain('earlier turn');

    const without = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    expect(userContent(without)).not.toContain('Recent conversation');
  });

  it('marks a required slot and renders its guidelines', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'q1', required: true, guidelines: 'Use full legal name' })],
      })
    );
    const content = userContent(messages);
    expect(content).toContain('required: true');
    expect(content).toContain('guidelines: Use full legal name');
  });

  it('renders a likert slot scale as min–max', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'rating', type: 'likert', typeConfig: { min: 1, max: 7 } })],
      })
    );
    expect(userContent(messages)).toContain('scale: 1–7');
  });

  it('renders a choice option with no label as the bare value', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [
          slot({
            key: 'colour',
            type: 'single_choice',
            typeConfig: { choices: [{ value: 'red' }] },
          }),
        ],
      })
    );
    const content = userContent(messages);
    expect(content).toContain('options: red');
    expect(content).not.toContain('red (');
  });
});

describe('buildAnswerExtractionRetryMessage', () => {
  it('names the invalid field paths when provided', () => {
    const msg = buildAnswerExtractionRetryMessage(['answers.0.confidence']);
    expect(msg).toContain('answers.0.confidence');
  });
  it('falls back to a generic message when no paths are given', () => {
    const msg = buildAnswerExtractionRetryMessage([]);
    expect(msg).toMatch(/not valid JSON/);
  });
});
