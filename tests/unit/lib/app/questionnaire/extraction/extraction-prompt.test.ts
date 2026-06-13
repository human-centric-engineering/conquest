import { describe, expect, it } from 'vitest';

import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import {
  attachmentsToContentParts,
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';
import type { ContentPart } from '@/lib/orchestration/llm/types';
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

  it('frames an open prompt (no "Active question key") in data-slot mode', () => {
    // activeQuestionKey: null → data-slot mode: the respondent is answering an open conversational
    // prompt, so the extractor is told there is no single active question (vs naming one).
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'name', prompt: 'What is your name?' })],
        activeQuestionKey: null,
        userMessage: 'I am Dana',
      })
    );
    const content = userContent(messages);
    expect(content).not.toContain('Active question key');
    expect(content).toContain('there is no single active question');
    // Still lists the candidate questions to extract background answers into.
    expect(content).toContain('What is your name?');
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

describe('buildAnswerExtractionPrompt — attachments', () => {
  it('keeps the user content a plain string when there are no attachments', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    expect(typeof messages[1]?.content).toBe('string');
  });

  it('makes the user content multimodal (text + parts) when attachments are present', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'q1' })],
        userMessage: 'see attached',
        attachments: [
          { name: 'photo.png', mediaType: 'image/png', data: 'aW1n' },
          { name: 'cv.pdf', mediaType: 'application/pdf', data: 'cGRm' },
        ],
      })
    );
    const content = messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as ContentPart[];
    // First part is the text (carrying the message + an attachment note); then one part per file.
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('see attached');
    expect((parts[0] as { text: string }).text).toContain('attached 2 file');
    expect(parts[1]).toMatchObject({ type: 'image' });
    expect(parts[2]).toMatchObject({ type: 'document', name: 'cv.pdf' });
  });
});

describe('attachmentsToContentParts', () => {
  it('maps images to image parts and everything else to named document parts', () => {
    const parts = attachmentsToContentParts([
      { name: 'a.webp', mediaType: 'image/webp', data: 'aW1n' },
      { name: 'notes.txt', mediaType: 'text/plain', data: 'dHh0' },
    ]);
    expect(parts[0]).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/webp', data: 'aW1n' },
    });
    expect(parts[1]).toEqual({
      type: 'document',
      source: { type: 'base64', mediaType: 'text/plain', data: 'dHh0' },
      name: 'notes.txt',
    });
  });
});

describe('buildAnswerExtractionPrompt — data slots', () => {
  function systemContent(messages: ReturnType<typeof buildAnswerExtractionPrompt>): string {
    const sys = messages.find((m) => m.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : '';
  }

  it('lists data-slot candidates and demands specific, non-meta paraphrases', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        {
          key: 'demographics',
          name: 'Employee Demographics',
          description: 'Age + gender',
          theme: 'About',
        },
      ],
    });
    expect(userContent(messages)).toContain('demographics');
    const system = systemContent(messages);
    // The rules must steer away from meta-summaries toward the actual values.
    expect(system).toContain('25-year-old male');
    expect(system).toMatch(/specifics/i);
  });

  it("renders a slot's current fill so the model can update/correct it", () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        {
          key: 'demographics',
          name: 'Employee Demographics',
          description: 'Age + gender',
          theme: 'About',
          current: {
            value: { age: 25, gender: 'male' },
            paraphrase: 'A 25-year-old male.',
            confidence: 0.9,
          },
        },
      ],
    });
    const content = userContent(messages);
    expect(content).toContain('current: A 25-year-old male.');
    expect(systemContent(messages)).toMatch(/CORRECTS?/);
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
