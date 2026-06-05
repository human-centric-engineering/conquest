import { describe, expect, it } from 'vitest';

import {
  buildCompletionOfferPrompt,
  buildCompletionOfferRetryMessage,
  type CompletionOfferPromptInput,
} from '@/lib/app/questionnaire/completion';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

/** Narrow a message's `content` (string | ContentPart[]) to a plain string. */
function text(message: LlmMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

const baseInput: CompletionOfferPromptInput = {
  coverage: 1,
  answeredCount: 3,
  capReached: false,
  coveredSlots: [
    { key: 'goal', prompt: 'What is your goal?' },
    { key: 'when', prompt: 'When do you want to start?' },
  ],
  remainingSlots: [],
  recentMessages: ['I think that covers it', 'thanks'],
};

describe('buildCompletionOfferPrompt', () => {
  it('emits a system rules message and a user message', () => {
    const messages = buildCompletionOfferPrompt(baseInput);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('does not ask the model to re-decide eligibility', () => {
    const system = text(buildCompletionOfferPrompt(baseInput)[0]);
    expect(system.toLowerCase()).toContain('already determined');
  });

  it('includes coverage stats and the covered questions in the user message', () => {
    const user = text(buildCompletionOfferPrompt(baseInput)[1]);
    expect(user).toContain('100%');
    expect(user).toContain('What is your goal?');
    expect(user).toContain('When do you want to start?');
  });

  it('frames the cap when the offer was cap-driven instead of coverage-driven', () => {
    const user = text(buildCompletionOfferPrompt({ ...baseInput, capReached: true })[1]);
    expect(user.toLowerCase()).toContain('cap');
  });

  it('lists optional remaining questions only when present', () => {
    const without = text(buildCompletionOfferPrompt(baseInput)[1]);
    expect(without.toLowerCase()).not.toContain('optional questions still open');

    const withRemaining = text(
      buildCompletionOfferPrompt({
        ...baseInput,
        remainingSlots: [{ key: 'extra', prompt: 'Anything else?' }],
      })[1]
    );
    expect(withRemaining).toContain('Anything else?');
  });

  it('is deterministic for the same input', () => {
    expect(buildCompletionOfferPrompt(baseInput)).toEqual(buildCompletionOfferPrompt(baseInput));
  });
});

describe('buildCompletionOfferRetryMessage', () => {
  it('names the invalid paths when provided', () => {
    const msg = buildCompletionOfferRetryMessage(['offerMessage']);
    expect(msg).toContain('offerMessage');
  });

  it('falls back to a generic message with no paths', () => {
    const msg = buildCompletionOfferRetryMessage([]);
    expect(msg.toLowerCase()).toContain('not valid json');
  });
});
