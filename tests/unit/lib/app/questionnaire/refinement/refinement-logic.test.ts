import { describe, expect, it } from 'vitest';

import {
  applyRefinement,
  normalizeRefinementDecisions,
  summarizeRefinements,
} from '@/lib/app/questionnaire/refinement/refinement-logic';
import type {
  RefinementDecision,
  RefinementHistoryEntry,
} from '@/lib/app/questionnaire/refinement/types';

import {
  choiceSlot,
  ctx,
  decision,
  existing,
  slot,
} from '@/tests/unit/lib/app/questionnaire/refinement/_fixtures';

describe('normalizeRefinementDecisions', () => {
  it('keeps a well-formed refine against an answered slot', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a', value: 'old' })] });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'a', action: 'refine', newValue: 'new' })],
      context
    );
    expect(dropped).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ slotKey: 'a', action: 'refine', newValue: 'new' });
    // questionType is resolved from the slot, not the LLM.
    expect(decisions[0]?.questionType).toBe('free_text');
  });

  it('filters out a leave decision (a deliberate non-change, not a drop)', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a' })] });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'a', action: 'leave', newValue: undefined })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it('drops a decision referencing an unknown slot key', () => {
    const context = ctx({
      slots: [slot({ key: 'a' })],
      existingAnswers: [existing({ slotKey: 'a' })],
    });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'ghost', newValue: 'x' })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/unknown slot key/);
  });

  it('drops a decision for a known but not-yet-answered slot', () => {
    const context = ctx({
      slots: [slot({ key: 'a' }), slot({ key: 'b' })],
      existingAnswers: [existing({ slotKey: 'a' })], // b exists but is unanswered
    });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'b', newValue: 'x' })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/not already answered/);
  });

  it('drops a refine/overwrite without a newValue', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a' })] });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'a', action: 'overwrite', newValue: undefined })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/without a newValue/);
  });

  it('drops a value that fails the slot type (choice membership)', () => {
    const context = ctx({
      slots: [choiceSlot('color', 'single_choice', 'red', 'green', 'blue')],
      existingAnswers: [existing({ slotKey: 'color', value: 'red' })],
    });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'color', newValue: 'purple' })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/value fails type/);
  });

  it('normalises a valid new value via answer-value (numeric string → number)', () => {
    const context = ctx({
      slots: [slot({ key: 'age', type: 'numeric' })],
      existingAnswers: [existing({ slotKey: 'age', value: 30 })],
    });
    const { decisions } = normalizeRefinementDecisions(
      [decision({ slotKey: 'age', newValue: '34' })],
      context
    );
    expect(decisions[0]?.newValue).toBe(34);
  });

  it('drops a no-op where the new value equals the existing value', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a', value: 'same' })] });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'a', newValue: 'same' })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/no-op/);
  });

  it('treats a multi_choice re-stated in a different order as a no-op', () => {
    const context = ctx({
      slots: [choiceSlot('langs', 'multi_choice', 'ts', 'go', 'rs')],
      existingAnswers: [existing({ slotKey: 'langs', value: ['ts', 'go'] })],
    });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [decision({ slotKey: 'langs', newValue: ['go', 'ts'] })],
      context
    );
    expect(decisions).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/no-op/);
  });

  it('de-duplicates per slot, keeping the higher-confidence decision', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a', value: 'old' })] });
    const { decisions, dropped } = normalizeRefinementDecisions(
      [
        decision({ slotKey: 'a', newValue: 'low', confidence: 0.6, rationale: 'low' }),
        decision({ slotKey: 'a', newValue: 'high', confidence: 0.95, rationale: 'high' }),
      ],
      context
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.confidence).toBe(0.95);
    expect(decisions[0]?.rationale).toBe('high');
    expect(dropped[0]?.reason).toMatch(/duplicate decision/);
  });

  it('keeps the first decision on a confidence tie (stable)', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a', value: 'old' })] });
    const { decisions } = normalizeRefinementDecisions(
      [
        decision({ slotKey: 'a', newValue: 'first', confidence: 0.7, rationale: 'first' }),
        decision({ slotKey: 'a', newValue: 'second', confidence: 0.7, rationale: 'second' }),
      ],
      context
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.rationale).toBe('first');
  });

  it('returns empty for empty input', () => {
    const context = ctx({ existingAnswers: [existing({ slotKey: 'a' })] });
    const { decisions, dropped } = normalizeRefinementDecisions([], context);
    expect(decisions).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });
});

describe('applyRefinement', () => {
  const baseDecision: RefinementDecision = {
    slotKey: 'a',
    action: 'refine',
    questionType: 'free_text',
    newValue: 'new value',
    rationale: 'reconsidered',
    source: 'contradiction',
    confidence: 0.9,
  };

  it('a refine sets provenance to refined and appends a history entry', () => {
    const before = existing({ slotKey: 'a', value: 'old value', provenance: 'direct' });
    const after = applyRefinement(before, baseDecision);
    expect(after.value).toBe('new value');
    expect(after.provenance).toBe('refined');
    // The refinement's certainty becomes the slot's new confidence (refining can improve it).
    expect(after.confidence).toBe(0.9);
    expect(after.refinementHistory).toHaveLength(1);
    expect(after.refinementHistory[0]).toMatchObject({
      previousValue: 'old value',
      previousProvenance: 'direct',
      newValue: 'new value',
      source: 'contradiction',
    });
  });

  it('an overwrite keeps the original provenance but still appends history', () => {
    const before = existing({ slotKey: 'a', value: 'typo', provenance: 'direct' });
    const after = applyRefinement(before, {
      ...baseDecision,
      action: 'overwrite',
      newValue: 'fixed',
      source: 'correction',
    });
    expect(after.value).toBe('fixed');
    expect(after.provenance).toBe('direct'); // unchanged — a typo fix is not an evolution
    expect(after.refinementHistory).toHaveLength(1);
    expect(after.refinementHistory[0]?.source).toBe('correction');
  });

  it('appends to existing history rather than replacing it', () => {
    const prior: RefinementHistoryEntry = {
      previousValue: 'v0',
      previousProvenance: 'direct',
      newValue: 'v1',
      rationale: 'first refine',
      source: 'clarification',
    };
    const before = existing({
      slotKey: 'a',
      value: 'v1',
      provenance: 'refined',
      refinementHistory: [prior],
    });
    const after = applyRefinement(before, { ...baseDecision, newValue: 'v2' });
    expect(after.refinementHistory).toHaveLength(2);
    expect(after.refinementHistory[0]).toBe(prior);
    expect(after.refinementHistory[1]?.newValue).toBe('v2');
  });

  it('carries the existing turnIndex into the history entry when present', () => {
    const before = existing({ slotKey: 'a', value: 'old', turnIndex: 3 });
    const after = applyRefinement(before, baseDecision);
    expect(after.refinementHistory[0]?.turnIndex).toBe(3);
  });

  it('omits turnIndex from the entry on the hand-driven path (no turn loop)', () => {
    const before = existing({ slotKey: 'a', value: 'old' });
    const after = applyRefinement(before, baseDecision);
    expect(after.refinementHistory[0] && 'turnIndex' in after.refinementHistory[0]).toBe(false);
  });

  it('does not mutate the input answer', () => {
    const before = existing({ slotKey: 'a', value: 'old', provenance: 'direct' });
    applyRefinement(before, baseDecision);
    expect(before.value).toBe('old');
    expect(before.provenance).toBe('direct');
    expect(before.refinementHistory).toBeUndefined();
  });
});

describe('summarizeRefinements', () => {
  it('counts refine and overwrite actions and carries the dropped count', () => {
    const decisions: RefinementDecision[] = [
      {
        slotKey: 'a',
        action: 'refine',
        questionType: 'free_text',
        newValue: 'x',
        rationale: 'r',
        source: 'contradiction',
        confidence: 0.9,
      },
      {
        slotKey: 'b',
        action: 'overwrite',
        questionType: 'free_text',
        newValue: 'y',
        rationale: 'r',
        source: 'correction',
        confidence: 0.8,
      },
      {
        slotKey: 'c',
        action: 'refine',
        questionType: 'free_text',
        newValue: 'z',
        rationale: 'r',
        source: 'clarification',
        confidence: 0.7,
      },
    ];
    expect(summarizeRefinements(decisions, 2)).toEqual({
      refineCount: 2,
      overwriteCount: 1,
      droppedCount: 2,
    });
  });

  it('returns zeroes for an empty decision list', () => {
    expect(summarizeRefinements([], 0)).toEqual({
      refineCount: 0,
      overwriteCount: 0,
      droppedCount: 0,
    });
  });
});
