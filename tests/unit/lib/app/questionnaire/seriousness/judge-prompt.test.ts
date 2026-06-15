/**
 * buildSeriousnessJudgePrompt — unit tests.
 *
 * Pure function: strings in, { system, user } out. No mocks required.
 *
 * Test Coverage:
 * - Returns an object with both `system` and `user` keys
 * - `system` contains the policy content (lenient-reviewer instructions)
 * - `user` message includes the question prompt text
 * - `user` message includes the respondent's answer
 * - `user` message includes the extracted value when provided
 * - `user` message omits the extracted-value section when absent
 * - `user` message includes recent conversation context when provided
 * - `user` message omits conversation context when the array is absent or empty
 * - `user` message handles a missing questionPrompt (empty string → fallback label)
 * - `user` message caps recent messages to the last 4
 * - Structural JSON format hint appears in the user message
 *
 * @see lib/app/questionnaire/seriousness/judge-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import { buildSeriousnessJudgePrompt } from '@/lib/app/questionnaire/seriousness/judge-prompt';
import type { SeriousnessJudgeInput } from '@/lib/app/questionnaire/seriousness/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(over: Partial<SeriousnessJudgeInput> = {}): SeriousnessJudgeInput {
  return {
    questionPrompt: 'How satisfied are you with your work environment?',
    userMessage: 'Pretty satisfied, mostly.',
    sessionId: 'sess-1',
    ...over,
  };
}

// ─── Structure ───────────────────────────────────────────────────────────────

describe('buildSeriousnessJudgePrompt — structure', () => {
  it('returns an object with both system and user string keys', () => {
    // Arrange
    const input = makeInput();

    // Act
    const result = buildSeriousnessJudgePrompt(input);

    // Assert: the caller destructures { system, user } — both must be present strings
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
    expect(result.system.length).toBeGreaterThan(0);
    expect(result.user.length).toBeGreaterThan(0);
  });
});

// ─── System prompt ───────────────────────────────────────────────────────────

describe('buildSeriousnessJudgePrompt — system prompt', () => {
  it('system prompt encodes the lenient-reviewer policy language', () => {
    // Arrange / Act
    const { system } = buildSeriousnessJudgePrompt(makeInput());

    // Assert: key policy phrases that the invoker relies on
    expect(system).toContain('lenient reviewer');
    expect(system).toContain('"serious": boolean');
    expect(system).toContain('"reason": string');
  });

  it('system prompt instructs the model to default to KEEP', () => {
    // Arrange / Act
    const { system } = buildSeriousnessJudgePrompt(makeInput());

    // Assert
    expect(system).toContain('KEEP');
  });

  it('system prompt makes safeguarding disclosures always genuine (override rule)', () => {
    const { system } = buildSeriousnessJudgePrompt(makeInput());
    // Defense-in-depth: even when sensitivity awareness is off, the judge must never set a
    // disclosure of harm aside, however implausible it sounds.
    expect(system).toMatch(/SAFEGUARDING/i);
    expect(system).toMatch(/never set a disclosure of harm aside/i);
  });

  it('system prompt names the three failure categories', () => {
    // Arrange / Act
    const { system } = buildSeriousnessJudgePrompt(makeInput());

    // Assert: ABUSIVE, PREPOSTEROUS, NONSENSICAL must appear for the policy to be complete
    expect(system).toContain('ABUSIVE');
    expect(system).toContain('PREPOSTEROUS');
    expect(system).toContain('NONSENSICAL');
  });

  it('system prompt is stable across calls with different inputs', () => {
    // Arrange
    const a = buildSeriousnessJudgePrompt(makeInput({ userMessage: 'hello' }));
    const b = buildSeriousnessJudgePrompt(makeInput({ userMessage: 'goodbye' }));

    // Act / Assert: the system prompt must not embed per-call data
    expect(a.system).toBe(b.system);
  });
});

// ─── User message — required fields ──────────────────────────────────────────

describe('buildSeriousnessJudgePrompt — user message required content', () => {
  it('user message includes the question prompt', () => {
    // Arrange
    const input = makeInput({ questionPrompt: 'Rate your manager.' });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: question text is embedded in the user message
    expect(user).toContain('Rate your manager.');
  });

  it('user message includes the respondent answer', () => {
    // Arrange
    const input = makeInput({ userMessage: 'I think it could be better.' });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert
    expect(user).toContain('I think it could be better.');
  });

  it('user message carries the JSON verdict instruction', () => {
    // Arrange / Act
    const { user } = buildSeriousnessJudgePrompt(makeInput());

    // Assert: the invoker relies on this to prompt a JSON-only response
    expect(user).toContain('JSON verdict');
  });

  it('user message labels the question section', () => {
    // Arrange / Act
    const { user } = buildSeriousnessJudgePrompt(makeInput());

    // Assert: structural label so the model identifies which part is the question
    expect(user).toContain('QUESTION ASKED');
  });

  it('user message labels the answer section', () => {
    // Arrange / Act
    const { user } = buildSeriousnessJudgePrompt(makeInput());

    // Assert
    expect(user).toContain("RESPONDENT'S ANSWER");
  });
});

// ─── User message — extracted value ──────────────────────────────────────────

describe('buildSeriousnessJudgePrompt — extractedValue', () => {
  it('includes the JSON-serialised extractedValue when provided', () => {
    // Arrange: number value
    const input = makeInput({ extractedValue: 543 });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: the value is serialised and embedded — the model uses it as a cross-check signal
    expect(user).toContain('VALUE PARSED FROM THE ANSWER');
    expect(user).toContain('543');
  });

  it('JSON-serialises object extractedValues correctly', () => {
    // Arrange
    const input = makeInput({ extractedValue: { score: 7, label: 'good' } });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: JSON.stringify is applied — not toString()
    expect(user).toContain('"score":7');
    expect(user).toContain('"label":"good"');
  });

  it('omits the extracted-value section when extractedValue is absent', () => {
    // Arrange: no extractedValue key
    const input = makeInput();

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: section label should not appear
    expect(user).not.toContain('VALUE PARSED FROM THE ANSWER');
  });

  it('includes the section when extractedValue is 0 (falsy but defined)', () => {
    // Arrange: 0 is a valid parsed value (e.g. a rating of 0)
    const input = makeInput({ extractedValue: 0 });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: the check is `!== undefined`, not falsy
    expect(user).toContain('VALUE PARSED FROM THE ANSWER');
    expect(user).toContain('0');
  });

  it('includes the section when extractedValue is false (boolean)', () => {
    // Arrange
    const input = makeInput({ extractedValue: false });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert
    expect(user).toContain('VALUE PARSED FROM THE ANSWER');
    expect(user).toContain('false');
  });

  it('includes the section when extractedValue is null', () => {
    // Arrange: the invoker may pass null when the extractor returned null
    const input = makeInput({ extractedValue: null });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: null !== undefined, so the branch fires
    expect(user).toContain('VALUE PARSED FROM THE ANSWER');
    expect(user).toContain('null');
  });
});

// ─── User message — recent messages ──────────────────────────────────────────

describe('buildSeriousnessJudgePrompt — recentMessages', () => {
  it('includes recent conversation context when provided', () => {
    // Arrange
    const input = makeInput({
      recentMessages: ['Tell me about your team.', 'We are a small team of five.'],
    });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: both the section label and the content appear
    expect(user).toContain('RECENT CONVERSATION');
    expect(user).toContain('Tell me about your team.');
    expect(user).toContain('We are a small team of five.');
  });

  it('omits the recent-conversation section when recentMessages is absent', () => {
    // Arrange
    const input = makeInput(); // no recentMessages key

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert
    expect(user).not.toContain('RECENT CONVERSATION');
  });

  it('omits the recent-conversation section when recentMessages is an empty array', () => {
    // Arrange
    const input = makeInput({ recentMessages: [] });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert
    expect(user).not.toContain('RECENT CONVERSATION');
  });

  it('caps recent messages to the last 4 when more are supplied', () => {
    // Arrange: 6 messages — only the last 4 should appear
    const messages = ['msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6'];
    const input = makeInput({ recentMessages: messages });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: first two messages are truncated
    expect(user).not.toContain('msg1');
    expect(user).not.toContain('msg2');
    expect(user).toContain('msg3');
    expect(user).toContain('msg4');
    expect(user).toContain('msg5');
    expect(user).toContain('msg6');
  });

  it('includes all messages when exactly 4 are supplied (boundary)', () => {
    // Arrange
    const messages = ['a', 'b', 'c', 'd'];
    const input = makeInput({ recentMessages: messages });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: .slice(-4) on a 4-element array returns all 4
    expect(user).toContain('a');
    expect(user).toContain('b');
    expect(user).toContain('c');
    expect(user).toContain('d');
  });

  it('joins recent messages with newlines', () => {
    // Arrange
    const messages = ['first line', 'second line'];
    const input = makeInput({ recentMessages: messages });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: the source calls .join('\n') — verify the two lines appear adjacent
    expect(user).toContain('first line\nsecond line');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('buildSeriousnessJudgePrompt — edge cases', () => {
  it('uses a fallback label when questionPrompt is an empty string', () => {
    // Arrange: the source code uses `input.questionPrompt || '(no specific question)'`
    const input = makeInput({ questionPrompt: '' });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: the fallback text appears instead of an empty block
    expect(user).toContain('(no specific question)');
  });

  it('renders a very long userMessage without truncation', () => {
    // Arrange: the function places the raw message in the user block with no cap
    const longMessage = 'word '.repeat(500).trim();
    const input = makeInput({ userMessage: longMessage });

    // Act
    const { user } = buildSeriousnessJudgePrompt(input);

    // Assert: first and last words of the long message are present
    expect(user).toContain('word word');
    expect(user.length).toBeGreaterThan(longMessage.length);
  });
});
