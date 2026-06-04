import { describe, expect, it } from 'vitest';

import { normalizeAnswerIntents } from '@/lib/app/questionnaire/extraction/answer-intents';
import {
  answer,
  choiceSlot,
  ctx,
  slot,
} from '@/tests/unit/lib/app/questionnaire/extraction/_fixtures';

describe('normalizeAnswerIntents — slot resolution', () => {
  it('drops an answer whose slotKey is not a candidate', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents, dropped } = normalizeAnswerIntents([answer({ slotKey: 'ghost' })], c);
    expect(intents).toHaveLength(0);
    expect(dropped).toEqual([{ slotKey: 'ghost', reason: 'unknown slot key' }]);
  });

  it('builds an intent for a valid answer, resolving questionType from the slot', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1', type: 'free_text' })] });
    const { intents } = normalizeAnswerIntents(
      [answer({ slotKey: 'q1', value: 'hi', sourceQuote: 'hi' })],
      c
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.questionType).toBe('free_text');
    expect(intents[0]?.value).toBe('hi');
  });
});

describe('normalizeAnswerIntents — value validation', () => {
  it('drops an answer whose value fails the slot type, naming the issue', () => {
    const c = ctx({ candidateSlots: [choiceSlot('colour', 'single_choice', 'red', 'blue')] });
    const { intents, dropped } = normalizeAnswerIntents(
      [answer({ slotKey: 'colour', value: 'purple' })],
      c
    );
    expect(intents).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/value invalid for type/);
  });

  it('records the normalised value (deduped multi_choice array)', () => {
    const c = ctx({ candidateSlots: [choiceSlot('tags', 'multi_choice', 'a', 'b')] });
    const { intents } = normalizeAnswerIntents(
      [answer({ slotKey: 'tags', value: ['a', 'a', 'b'] })],
      c
    );
    expect(intents[0]?.value).toEqual(['a', 'b']);
  });
});

describe('normalizeAnswerIntents — provenance coercion', () => {
  it('downgrades a direct answer with no sourceQuote to inferred', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents } = normalizeAnswerIntents(
      [answer({ slotKey: 'q1', provenance: 'direct', sourceQuote: undefined })],
      c
    );
    expect(intents[0]?.provenance).toBe('inferred');
    expect(intents[0]?.sourceQuote).toBeUndefined();
  });

  it('downgrades a direct answer whose sourceQuote is blank (empty/whitespace)', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents } = normalizeAnswerIntents(
      [answer({ slotKey: 'q1', provenance: 'direct', sourceQuote: '   ' })],
      c
    );
    expect(intents[0]?.provenance).toBe('inferred');
    // The non-substantiating quote is dropped, not carried on the intent.
    expect(intents[0]?.sourceQuote).toBeUndefined();
  });

  it('keeps a direct answer that carries a sourceQuote', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents } = normalizeAnswerIntents(
      [answer({ slotKey: 'q1', value: 'Dana', provenance: 'direct', sourceQuote: 'Dana' })],
      c
    );
    expect(intents[0]?.provenance).toBe('direct');
    expect(intents[0]?.sourceQuote).toBe('Dana');
  });

  it('passes a synthesised answer through unchanged, with no sourceQuote attached', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents } = normalizeAnswerIntents(
      [answer({ slotKey: 'q1', value: 'derived', provenance: 'synthesised' })],
      c
    );
    expect(intents[0]?.provenance).toBe('synthesised');
    expect(intents[0]?.sourceQuote).toBeUndefined();
  });
});

describe('normalizeAnswerIntents — active vs side-effect', () => {
  it('flags the active question and side-effects from one message', () => {
    const c = ctx({
      candidateSlots: [slot({ key: 'name' }), slot({ key: 'city' })],
      activeQuestionKey: 'name',
    });
    const { intents } = normalizeAnswerIntents(
      [
        answer({ slotKey: 'name', value: 'Dana', sourceQuote: 'Dana' }),
        answer({ slotKey: 'city', value: 'Leeds', sourceQuote: 'Leeds' }),
      ],
      c
    );
    expect(intents).toHaveLength(2);
    expect(intents.find((i) => i.slotKey === 'name')?.isActiveQuestion).toBe(true);
    expect(intents.find((i) => i.slotKey === 'city')?.isActiveQuestion).toBe(false);
  });
});

describe('normalizeAnswerIntents — de-duplication', () => {
  it('keeps the highest-confidence intent when a slot is answered twice', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents, dropped } = normalizeAnswerIntents(
      [
        answer({ slotKey: 'q1', value: 'low', confidence: 0.4, sourceQuote: 'low' }),
        answer({ slotKey: 'q1', value: 'high', confidence: 0.95, sourceQuote: 'high' }),
      ],
      c
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.value).toBe('high');
    expect(dropped).toEqual([{ slotKey: 'q1', reason: 'duplicate slot, lower confidence' }]);
  });

  it('keeps the first-seen intent on an exact confidence tie', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    const { intents, dropped } = normalizeAnswerIntents(
      [
        answer({ slotKey: 'q1', value: 'first', confidence: 0.8, sourceQuote: 'first' }),
        answer({ slotKey: 'q1', value: 'second', confidence: 0.8, sourceQuote: 'second' }),
      ],
      c
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.value).toBe('first');
    expect(dropped).toEqual([{ slotKey: 'q1', reason: 'duplicate slot, lower confidence' }]);
  });
});

describe('normalizeAnswerIntents — empty', () => {
  it('returns no intents for an empty answer list', () => {
    const c = ctx({ candidateSlots: [slot({ key: 'q1' })] });
    expect(normalizeAnswerIntents([], c)).toEqual({ intents: [], dropped: [] });
  });
});
