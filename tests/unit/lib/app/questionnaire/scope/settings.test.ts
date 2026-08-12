import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  MAX_CONDITIONAL_TOPICS_CEILING,
  narrowAdaptiveScopeSettings,
  narrowInterviewPlan,
  narrowProposedTopicSet,
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

describe('narrowProposedTopicSet', () => {
  /** A stored draft as the analysis route writes it. */
  function stored(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      topics: [
        {
          key: 'pipeline',
          label: 'Pipeline',
          phase: 'conditional',
          criteria: 'They named deals stalling.',
          depth: 'full',
          members: { questionKeys: ['q1'], dataSlotKeys: ['d1'] },
          rationale: 'The routing tab restricts this to sales-led businesses.',
          sourceQuote: 'Only cover pipeline for sales-led businesses.',
          replacesExisting: true,
        },
      ],
      rules: [
        {
          dataSlotKey: 'headcount',
          operator: 'gt',
          value: '50',
          action: 'include',
          topicKey: 'pipeline',
          rationale: 'Stated on the guardrails tab.',
        },
      ],
      maxConditionalTopics: 3,
      summary: 'Read from the routing tab.',
      fromDocument: true,
      generatedAt: '2026-08-12T10:00:00.000Z',
      ...overrides,
    };
  }

  it('round-trips a well-formed draft', () => {
    const set = narrowProposedTopicSet(stored());

    expect(set).not.toBeNull();
    expect(set?.topics[0]?.key).toBe('pipeline');
    expect(set?.topics[0]?.members.questionKeys).toEqual(['q1']);
    expect(set?.topics[0]?.sourceQuote).toBe('Only cover pipeline for sales-led businesses.');
    expect(set?.topics[0]?.replacesExisting).toBe(true);
    expect(set?.rules[0]?.operator).toBe('gt');
    expect(set?.maxConditionalTopics).toBe(3);
    expect(set?.fromDocument).toBe(true);
  });

  it.each([null, undefined, 'nonsense', 42, [], { v: 2, topics: [] }])(
    'resolves %p to null — no proposal, never a half-parsed one',
    (input) => {
      // An unreadable draft must read as "nothing to review". A partially-parsed set is the
      // dangerous outcome: the admin accepts it without noticing what silently fell out.
      expect(narrowProposedTopicSet(input)).toBeNull();
    }
  );

  it('drops a topic with no key or no label rather than keeping an unaddressable row', () => {
    const set = narrowProposedTopicSet(
      stored({
        topics: [
          { key: '', label: 'Nameless', phase: 'core', rationale: 'x' },
          { key: 'ok', label: '', phase: 'core', rationale: 'x' },
          { key: 'kept', label: 'Kept', phase: 'core', rationale: 'x' },
        ],
      })
    );
    expect(set?.topics.map((t) => t.key)).toEqual(['kept']);
  });

  it('omits sourceQuote entirely when the analyst inferred the topic', () => {
    // Presence of the quote is what tells a reviewer the document actually said this. An empty
    // string rendering as a blockquote would claim evidence that does not exist.
    const set = narrowProposedTopicSet(
      stored({
        topics: [{ key: 'x', label: 'X', phase: 'core', rationale: 'inferred', sourceQuote: '' }],
      })
    );
    expect(set?.topics[0]).not.toHaveProperty('sourceQuote');
  });

  it('omits the breadth limit when the document stated none', () => {
    const { maxConditionalTopics, ...withoutCap } = stored();
    void maxConditionalTopics;
    expect(narrowProposedTopicSet(withoutCap)).not.toHaveProperty('maxConditionalTopics');
  });

  it('falls back to fromDocument=false when the claim is missing or not a boolean', () => {
    // The weaker claim is the safe default: labelling a guess as document-read is the one failure
    // that gets an invented topic set accepted as the author's intent.
    expect(narrowProposedTopicSet(stored({ fromDocument: 'yes' }))?.fromDocument).toBe(false);
    expect(narrowProposedTopicSet(stored({ fromDocument: undefined }))?.fromDocument).toBe(false);
  });

  it('drops a rule naming no data slot or no topic', () => {
    const set = narrowProposedTopicSet(
      stored({
        rules: [
          { dataSlotKey: '', operator: 'exists', action: 'include', topicKey: 'p', rationale: 'x' },
          { dataSlotKey: 'd', operator: 'exists', action: 'include', topicKey: '', rationale: 'x' },
        ],
      })
    );
    expect(set?.rules).toEqual([]);
  });

  it('narrows an unknown operator or action to the safe default', () => {
    const set = narrowProposedTopicSet(
      stored({
        rules: [
          {
            dataSlotKey: 'd',
            operator: 'matches_regex',
            value: 'x',
            action: 'demolish',
            topicKey: 'p',
            rationale: 'x',
          },
        ],
      })
    );
    expect(set?.rules[0]?.operator).toBe('exists');
    expect(set?.rules[0]?.action).toBe('include');
  });
});
