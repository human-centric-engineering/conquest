/**
 * Unit tests: free-text answers carry a `paraphrase` through normalisation; typed answers don't.
 */

import { describe, it, expect } from 'vitest';

import { normalizeAnswerIntents } from '@/lib/app/questionnaire/extraction/answer-intents';
import type { ExtractedAnswer } from '@/lib/app/questionnaire/extraction/extraction-schema';
import { ctx, slot, choiceSlot } from '@/tests/unit/lib/app/questionnaire/extraction/_fixtures';

function freeTextAnswer(over: Partial<ExtractedAnswer> & { slotKey: string }): ExtractedAnswer {
  return {
    slotKey: over.slotKey,
    value: over.value ?? 'no — we never use the playbook, guidance is ad hoc',
    confidence: over.confidence ?? 0.8,
    provenance: over.provenance ?? 'direct',
    rationale: over.rationale ?? 'they described not using it',
    ...(over.sourceQuote !== undefined ? { sourceQuote: over.sourceQuote } : {}),
    ...(over.paraphrase !== undefined ? { paraphrase: over.paraphrase } : {}),
  };
}

describe('normalizeAnswerIntents — free-text paraphrase', () => {
  it('carries the paraphrase onto a free-text intent', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'comments', type: 'free_text' })] });
    const { intents } = normalizeAnswerIntents(
      [
        freeTextAnswer({
          slotKey: 'comments',
          sourceQuote: 'we never use the playbook',
          paraphrase: 'They say the playbook is "just a document" they "don\'t use".',
        }),
      ],
      c
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.paraphrase).toBe(
      'They say the playbook is "just a document" they "don\'t use".'
    );
    // The raw value is preserved alongside the paraphrase.
    expect(intents[0]?.value).toContain('playbook');
  });

  it('trims and omits a blank paraphrase', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'comments', type: 'free_text' })] });
    const { intents } = normalizeAnswerIntents(
      [freeTextAnswer({ slotKey: 'comments', paraphrase: '   ' })],
      c
    );
    expect(intents[0]?.paraphrase).toBeUndefined();
  });

  it('never sets a paraphrase on a typed (choice) answer even if the model sends one', () => {
    const c = ctx({ candidateSlots: [choiceSlot('colour', 'single_choice', 'red', 'blue')] });
    const { intents } = normalizeAnswerIntents(
      [
        {
          slotKey: 'colour',
          value: 'red',
          confidence: 0.9,
          provenance: 'direct',
          rationale: 'said red',
          sourceQuote: 'red',
          paraphrase: 'they like red',
        },
      ],
      c
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.questionType).toBe('single_choice');
    expect(intents[0]?.paraphrase).toBeUndefined();
  });
});
