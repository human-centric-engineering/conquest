/**
 * Intro-background authoring prompts — pure builders (F12.2).
 *
 * @see lib/app/questionnaire/intro/authoring-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildGenerateIntroBackgroundPrompt,
  buildRefineIntroBackgroundPrompt,
  buildIntroBackgroundRetryMessage,
} from '@/lib/app/questionnaire/intro/authoring-prompt';

describe('buildGenerateIntroBackgroundPrompt', () => {
  it('opens with a system rules message and a user message carrying the brief', () => {
    const msgs = buildGenerateIntroBackgroundPrompt('A survey for Acme engineers');
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/about this questionnaire/i);
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('A survey for Acme engineers');
  });

  it('asks for the JSON background contract', () => {
    const msgs = buildGenerateIntroBackgroundPrompt('x');
    expect(msgs[0].content).toMatch(/"background"/);
  });
});

describe('buildRefineIntroBackgroundPrompt', () => {
  it('includes both the current text and the instruction', () => {
    const msgs = buildRefineIntroBackgroundPrompt('Current text here', 'Make it warmer');
    const user = msgs.find((m) => m.role === 'user')!;
    expect(user.content).toContain('Current text here');
    expect(user.content).toContain('Make it warmer');
  });
});

describe('buildIntroBackgroundRetryMessage', () => {
  it('returns a string nudging the JSON contract', () => {
    const retry = buildIntroBackgroundRetryMessage();
    expect(typeof retry).toBe('string');
    expect(retry).toMatch(/"background"/);
  });
});
