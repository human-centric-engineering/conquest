/**
 * Prompt builder for the ingestion-time Adaptive Scope candidacy check — unit tests (P17.19).
 *
 * Pure and provider-agnostic, so tests focus on the message shape and the one behavioural rule
 * worth pinning: the rubric must keep telling the model not to infer routing from question variety
 * alone, since a future prompt edit could silently drop that and turn every long document into a
 * false-positive candidate.
 *
 * @see lib/app/questionnaire/scope/candidacy-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildScopeCandidacyPrompt,
  buildScopeCandidacyRetryMessage,
} from '@/lib/app/questionnaire/scope/candidacy-prompt';

describe('buildScopeCandidacyPrompt', () => {
  it('returns exactly a system message followed by a user message', () => {
    const messages = buildScopeCandidacyPrompt({ documentText: 'Some document text.' });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes the document text verbatim in the user message', () => {
    const documentText = 'Only ask the Partner Channel section if they sell through resellers.';
    const [, user] = buildScopeCandidacyPrompt({ documentText });

    expect(typeof user.content).toBe('string');
    expect(user.content as string).toContain(documentText);
  });

  it("names the file in the user message's header when documentFileName is supplied", () => {
    const [, user] = buildScopeCandidacyPrompt({
      documentText: 'Route by company size.',
      documentFileName: 'channel-instrument.pdf',
    });

    expect(user.content as string).toContain('SOURCE DOCUMENT (channel-instrument.pdf):');
  });

  it('uses a generic header when documentFileName is not supplied', () => {
    const [, user] = buildScopeCandidacyPrompt({ documentText: 'Route by company size.' });

    expect(user.content as string).toContain('SOURCE DOCUMENT:');
    expect(user.content as string).not.toContain('SOURCE DOCUMENT (');
  });

  it('instructs the model not to infer conditionality from question variety alone', () => {
    // The one behavioural rule most worth pinning — without it a future prompt edit could
    // silently turn every long, varied document into a false-positive candidate.
    const [system] = buildScopeCandidacyPrompt({ documentText: 'x' });
    const rubric = system.content as string;

    expect(rubric).toContain('Do not infer conditionality from question variety alone');
    expect(rubric).toContain('does NOT count');
  });
});

describe('buildScopeCandidacyRetryMessage', () => {
  it('returns a non-empty string mentioning JSON', () => {
    const message = buildScopeCandidacyRetryMessage();

    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain('JSON');
  });
});
