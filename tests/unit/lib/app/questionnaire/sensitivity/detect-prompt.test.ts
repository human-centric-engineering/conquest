/**
 * buildSensitivityDetectPrompt — unit tests.
 *
 * Pure function: strings in, { system, user } out. No mocks. Asserts the policy language the
 * invoker relies on and the user-message framing (question + answer + optional recent context).
 *
 * @see lib/app/questionnaire/sensitivity/detect-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import { buildSensitivityDetectPrompt } from '@/lib/app/questionnaire/sensitivity/detect-prompt';
import type { SensitivityDetectInput } from '@/lib/app/questionnaire/sensitivity/types';

function makeInput(over: Partial<SensitivityDetectInput> = {}): SensitivityDetectInput {
  return {
    questionPrompt: 'How do you feel about your role?',
    userMessage: "i'm being abused by my manager",
    sessionId: 'sess-1',
    ...over,
  };
}

describe('buildSensitivityDetectPrompt — structure', () => {
  it('returns both system and user strings', () => {
    const { system, user } = buildSensitivityDetectPrompt(makeInput());
    expect(system.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
  });

  it('system prompt is stable across different inputs (no per-call data embedded)', () => {
    const a = buildSensitivityDetectPrompt(makeInput({ userMessage: 'a' }));
    const b = buildSensitivityDetectPrompt(makeInput({ userMessage: 'b' }));
    expect(a.system).toBe(b.system);
  });
});

describe('buildSensitivityDetectPrompt — policy language', () => {
  it('encodes the JSON verdict shape', () => {
    const { system } = buildSensitivityDetectPrompt(makeInput());
    expect(system).toContain('"detected"');
    expect(system).toContain('"severity"');
    expect(system).toContain('"summary"');
  });

  it('treats a first-person harm statement as a high-severity disclosure', () => {
    const { system } = buildSensitivityDetectPrompt(makeInput());
    expect(system).toMatch(/FIRST-PERSON/i);
    expect(system).toMatch(/severity "high"/i);
  });

  it('separates pure hostility/profanity (seriousness gate) from safeguarding', () => {
    // The detector must NOT classify bare hostility as a disclosure — that is the gate's job.
    const { system } = buildSensitivityDetectPrompt(makeInput());
    expect(system).toMatch(/seriousness gate/i);
  });

  it('requires a careful, non-graphic summary', () => {
    const { system } = buildSensitivityDetectPrompt(makeInput());
    expect(system).toMatch(/NON-GRAPHIC/i);
  });

  it('scopes detection to the current message — a prior disclosure does not flag later abuse', () => {
    // The reintroduced bug: with the disclosure in recent context, the detector flagged later pure
    // abuse ("oh just fuck off") as sensitive, skipping the seriousness gate. The prompt must scope
    // the ruling to THIS message so context can't carry the flag forward.
    const { system } = buildSensitivityDetectPrompt(makeInput());
    expect(system).toMatch(/JUDGE ONLY THIS MESSAGE/i);
    expect(system).toMatch(/does NOT make the current message sensitive/i);
    expect(system).toMatch(/EVEN IF an earlier turn contained a genuine disclosure/i);
  });
});

describe('buildSensitivityDetectPrompt — user message', () => {
  it('includes the question and the respondent message', () => {
    const { user } = buildSensitivityDetectPrompt(
      makeInput({ questionPrompt: 'Rate your manager.', userMessage: 'they threaten me' })
    );
    expect(user).toContain('Rate your manager.');
    expect(user).toContain('they threaten me');
  });

  it('includes recent conversation when provided (capped to the last 4)', () => {
    const { user } = buildSensitivityDetectPrompt(
      makeInput({ recentMessages: ['m1', 'm2', 'm3', 'm4', 'm5'] })
    );
    expect(user).toContain('RECENT CONVERSATION');
    expect(user).not.toContain('m1');
    expect(user).toContain('m5');
  });

  it('omits the recent-conversation section when none is supplied', () => {
    const { user } = buildSensitivityDetectPrompt(makeInput());
    expect(user).not.toContain('RECENT CONVERSATION');
  });

  it('falls back to a label when the question prompt is empty (a disclosure needs no question)', () => {
    const { user } = buildSensitivityDetectPrompt(makeInput({ questionPrompt: '' }));
    expect(user).toContain('(no specific question)');
  });
});
