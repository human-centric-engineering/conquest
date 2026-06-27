/**
 * Unit test: the "Explain with AI" structured-output validator.
 *
 * Asserts it accepts a well-formed explanation, collapses an all-null suggestion
 * to `null` (prose-only advice belongs in the narrative), and rejects structural
 * mismatches so the runner retries.
 */

import { describe, it, expect } from 'vitest';

import { validateAgentSettingsExplanation } from '@/lib/app/questionnaire/agent-advisory/explain-schema';

describe('validateAgentSettingsExplanation', () => {
  it('accepts a valid explanation with an actionable suggestion', () => {
    const out = validateAgentSettingsExplanation({
      narrative: 'The current model is fine for this hot-path agent.',
      suggestion: {
        model: 'gpt-5.4-nano',
        temperature: null,
        maxTokens: null,
        reasoningEffort: 'minimal',
        rationale: 'Cheaper and indistinguishable for trivial selection.',
      },
    });
    expect(out).not.toBeNull();
    expect(out!.suggestion?.model).toBe('gpt-5.4-nano');
    expect(out!.suggestion?.reasoningEffort).toBe('minimal');
  });

  it('collapses an all-null suggestion to null', () => {
    const out = validateAgentSettingsExplanation({
      narrative: 'Settings already sound.',
      suggestion: { rationale: 'No change needed.' },
    });
    expect(out).not.toBeNull();
    expect(out!.suggestion).toBeNull();
  });

  it('defaults a missing suggestion to null', () => {
    const out = validateAgentSettingsExplanation({ narrative: 'All good.' });
    expect(out).not.toBeNull();
    expect(out!.suggestion).toBeNull();
  });

  it('rejects a missing narrative', () => {
    expect(validateAgentSettingsExplanation({ suggestion: null })).toBeNull();
  });

  it('rejects a suggestion without a rationale', () => {
    const out = validateAgentSettingsExplanation({
      narrative: 'x',
      suggestion: { model: 'gpt-5.4', temperature: null, maxTokens: null, reasoningEffort: null },
    });
    expect(out).toBeNull();
  });

  it('rejects an out-of-range temperature', () => {
    const out = validateAgentSettingsExplanation({
      narrative: 'x',
      suggestion: { temperature: 9, rationale: 'too hot' },
    });
    expect(out).toBeNull();
  });

  it('rejects an invalid reasoning effort', () => {
    const out = validateAgentSettingsExplanation({
      narrative: 'x',
      suggestion: { reasoningEffort: 'extreme', rationale: 'nope' },
    });
    expect(out).toBeNull();
  });
});
