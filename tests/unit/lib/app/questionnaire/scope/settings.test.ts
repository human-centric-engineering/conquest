import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  MAX_CONDITIONAL_TOPICS_CEILING,
  narrowAdaptiveScopeSettings,
  narrowInterviewPlan,
  narrowTopicMembers,
} from '@/lib/app/questionnaire/scope/types';

describe('narrowAdaptiveScopeSettings', () => {
  it('resolves an empty blob to the defaults, which are OFF', () => {
    const s = narrowAdaptiveScopeSettings({});

    expect(s).toEqual(DEFAULT_ADAPTIVE_SCOPE_SETTINGS);
    // The load-bearing default: a version that never opts in behaves exactly as it did pre-P17.
    expect(s.enabled).toBe(false);
  });

  it.each([null, undefined, 'nonsense', 42, []])('resolves %p to the defaults', (input) => {
    expect(narrowAdaptiveScopeSettings(input).enabled).toBe(false);
  });

  it('keeps the blind-spot check on by default', () => {
    // A diagnostic that only asks about the problem the respondent named can only confirm what
    // they already believed — so sampling one unraised area is the default, not an opt-in.
    expect(narrowAdaptiveScopeSettings({}).includeCheckTopic).toBe(true);
  });

  it('announces the plan by default', () => {
    expect(narrowAdaptiveScopeSettings({}).announce).toBe(true);
  });

  it('clamps maxConditionalTopics rather than rejecting it', () => {
    expect(narrowAdaptiveScopeSettings({ maxConditionalTopics: 0 }).maxConditionalTopics).toBe(1);
    expect(narrowAdaptiveScopeSettings({ maxConditionalTopics: 9999 }).maxConditionalTopics).toBe(
      MAX_CONDITIONAL_TOPICS_CEILING
    );
    expect(narrowAdaptiveScopeSettings({ maxConditionalTopics: 3.6 }).maxConditionalTopics).toBe(4);
  });

  it('clamps minConfidence into 0..1', () => {
    expect(narrowAdaptiveScopeSettings({ minConfidence: -2 }).minConfidence).toBe(0);
    expect(narrowAdaptiveScopeSettings({ minConfidence: 7 }).minConfidence).toBe(1);
  });

  it('drops blank and duplicate keys from key lists', () => {
    const s = narrowAdaptiveScopeSettings({
      fallbackTopicKeys: ['a', '  a  ', '', '   ', 'b', 7],
    });
    expect(s.fallbackTopicKeys).toEqual(['a', 'b']);
  });

  it('trims and caps free text', () => {
    const s = narrowAdaptiveScopeSettings({ plannerInstructions: `  ${'x'.repeat(5_000)}  ` });
    expect(s.plannerInstructions.length).toBe(4_000);
  });

  describe('rules', () => {
    it('drops a rule that names no data slot or no topic', () => {
      const s = narrowAdaptiveScopeSettings({
        rules: [
          { dataSlotKey: '', topicKey: 'x', operator: 'exists', action: 'include' },
          { dataSlotKey: 'y', topicKey: '', operator: 'exists', action: 'include' },
          { dataSlotKey: 'y', topicKey: 'x', operator: 'exists', action: 'include' },
        ],
      });
      // A rule that can only ever no-op would read to an admin as a rule quietly failing.
      expect(s.rules).toHaveLength(1);
      expect(s.rules[0]).toMatchObject({ dataSlotKey: 'y', topicKey: 'x' });
    });

    it('falls back to safe operator and action on unknown values', () => {
      const s = narrowAdaptiveScopeSettings({
        rules: [{ dataSlotKey: 'y', topicKey: 'x', operator: 'wat', action: 'destroy' }],
      });
      expect(s.rules[0]).toMatchObject({ operator: 'exists', action: 'include' });
    });

    it('nulls a blank operand so `exists` never compares against an empty string', () => {
      const s = narrowAdaptiveScopeSettings({
        rules: [
          { dataSlotKey: 'y', topicKey: 'x', operator: 'exists', action: 'include', value: '   ' },
        ],
      });
      expect(s.rules[0]?.value).toBeNull();
    });

    it('sorts by ordinal and back-fills a missing one from position', () => {
      const s = narrowAdaptiveScopeSettings({
        rules: [
          { dataSlotKey: 'a', topicKey: 't', operator: 'exists', action: 'include', ordinal: 5 },
          { dataSlotKey: 'b', topicKey: 't', operator: 'exists', action: 'include', ordinal: 1 },
        ],
      });
      expect(s.rules.map((r) => r.dataSlotKey)).toEqual(['b', 'a']);
    });

    it('gives every rule a stable id even when none was stored', () => {
      const s = narrowAdaptiveScopeSettings({
        rules: [{ dataSlotKey: 'a', topicKey: 't', operator: 'exists', action: 'include' }],
      });
      expect(s.rules[0]?.id).toBeTruthy();
    });
  });
});

describe('narrowTopicMembers', () => {
  it('resolves a missing or malformed blob to empty membership', () => {
    expect(narrowTopicMembers(undefined)).toEqual({ dataSlotKeys: [], questionKeys: [] });
    expect(narrowTopicMembers({ dataSlotKeys: 'nope' })).toEqual({
      dataSlotKeys: [],
      questionKeys: [],
    });
  });

  it('trims, de-duplicates and drops non-strings', () => {
    expect(narrowTopicMembers({ questionKeys: [' q1 ', 'q1', 3, '', 'q2'] })).toEqual({
      dataSlotKeys: [],
      questionKeys: ['q1', 'q2'],
    });
  });
});

describe('narrowInterviewPlan', () => {
  const valid = {
    v: 1,
    topics: [{ key: 'pipeline', depth: 'full', source: 'llm', rationale: 'deals stall' }],
    excluded: [{ key: 'talent', source: 'llm', rationale: 'not raised' }],
    checkTopicKey: 'data',
    confidence: 0.82,
    source: 'llm',
    respondentMessage: 'I want to go deeper on pipeline.',
    decidedAtTurn: 4,
    decidedAt: '2026-08-12T00:00:00.000Z',
  };

  it('round-trips a well-formed plan', () => {
    expect(narrowInterviewPlan(valid)).toEqual(valid);
  });

  it.each([null, undefined, 'nope', 42, [], {}])('returns null for %p', (input) => {
    expect(narrowInterviewPlan(input)).toBeNull();
  });

  it('returns null for an unknown schema version rather than guessing', () => {
    expect(narrowInterviewPlan({ ...valid, v: 2 })).toBeNull();
  });

  it('drops plan entries with no key instead of failing the whole plan', () => {
    const p = narrowInterviewPlan({
      ...valid,
      topics: [{ key: '', depth: 'full', source: 'llm', rationale: '' }, valid.topics[0]],
    });
    expect(p?.topics.map((t) => t.key)).toEqual(['pipeline']);
  });

  it('nulls a blank check topic', () => {
    expect(narrowInterviewPlan({ ...valid, checkTopicKey: '  ' })?.checkTopicKey).toBeNull();
  });

  it('clamps a confidence outside 0..1', () => {
    expect(narrowInterviewPlan({ ...valid, confidence: 1.4 })?.confidence).toBe(1);
    expect(narrowInterviewPlan({ ...valid, confidence: -1 })?.confidence).toBe(0);
  });

  it('falls back to a known depth and source on unknown values', () => {
    const p = narrowInterviewPlan({
      ...valid,
      topics: [{ key: 'x', depth: 'deep', source: 'vibes', rationale: '' }],
    });
    expect(p?.topics[0]).toMatchObject({ depth: 'full', source: 'llm' });
  });
});
