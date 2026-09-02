import { describe, it, expect } from 'vitest';

import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  DEFAULT_SECONDS_PER_DATA_SLOT,
  MAX_CONDITIONAL_TOPICS_CEILING,
  MEMBER_KEY_MAX_LENGTH,
  MAX_OPENING_PROBES_CEILING,
  MAX_OPENING_TURNS_CEILING,
  MIN_EARLY_SEATING_FLOOR,
  MAX_SECONDS_PER_ITEM,
  MAX_SESSION_BUDGET_SECONDS,
  MIN_SESSION_BUDGET_SECONDS,
  narrowConditionalTopicsSettings,
  narrowEarlySeating,
  narrowInterviewPlan,
  narrowProposedTopicSet,
  narrowTopicTrigger,
  MAX_TRIGGER_CUES,
  TRIGGER_CUE_MAX_LENGTH,
  narrowTopicMembers,
  TOPIC_KEY_MAX_LENGTH,
} from '@/lib/app/questionnaire/scope/types';

describe('narrowConditionalTopicsSettings', () => {
  it('resolves an empty blob to the defaults, which are OFF', () => {
    const s = narrowConditionalTopicsSettings({});

    expect(s).toEqual(DEFAULT_CONDITIONAL_TOPICS_SETTINGS);
    // The load-bearing default: a version that never opts in behaves exactly as it did pre-P17.
    expect(s.enabled).toBe(false);
  });

  it.each([null, undefined, 'nonsense', 42, []])('resolves %p to the defaults', (input) => {
    expect(narrowConditionalTopicsSettings(input).enabled).toBe(false);
  });

  it('keeps the blind-spot check on by default', () => {
    // A diagnostic that only asks about the problem the respondent named can only confirm what
    // they already believed — so sampling one unraised area is the default, not an opt-in.
    expect(narrowConditionalTopicsSettings({}).includeCheckTopic).toBe(true);
  });

  it('announces the plan by default', () => {
    expect(narrowConditionalTopicsSettings({}).announce).toBe(true);
  });

  it('clamps maxConditionalTopics rather than rejecting it', () => {
    expect(narrowConditionalTopicsSettings({ maxConditionalTopics: 0 }).maxConditionalTopics).toBe(
      1
    );
    expect(
      narrowConditionalTopicsSettings({ maxConditionalTopics: 9999 }).maxConditionalTopics
    ).toBe(MAX_CONDITIONAL_TOPICS_CEILING);
    expect(
      narrowConditionalTopicsSettings({ maxConditionalTopics: 3.6 }).maxConditionalTopics
    ).toBe(4);
  });

  it('clamps minConfidence into 0..1', () => {
    expect(narrowConditionalTopicsSettings({ minConfidence: -2 }).minConfidence).toBe(0);
    expect(narrowConditionalTopicsSettings({ minConfidence: 7 }).minConfidence).toBe(1);
  });

  it('drops blank and duplicate keys from key lists', () => {
    const s = narrowConditionalTopicsSettings({
      fallbackTopicKeys: ['a', '  a  ', '', '   ', 'b', 7],
    });
    expect(s.fallbackTopicKeys).toEqual(['a', 'b']);
  });

  it('trims and caps free text', () => {
    const s = narrowConditionalTopicsSettings({ plannerInstructions: `  ${'x'.repeat(5_000)}  ` });
    expect(s.plannerInstructions.length).toBe(4_000);
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

  /**
   * T13, the quietest of its three faces. This list was bounded by the TOPIC key length (64), but
   * every key in it is a REFERENCE to a question or data slot minted elsewhere, and nothing bounds
   * those at 64 — corpus doc 08 produced one of 78 characters. Truncating such a key does not
   * shorten it, it changes it into a key that resolves to nothing, which orphans the question. Per
   * `validate.ts`, an orphaned question "can never be asked, and nothing else in the system would
   * ever tell you" — so this silently deleted a question from the interview.
   */
  it('preserves a long question key rather than truncating it into one that matches nothing', () => {
    const longKey =
      'is_there_anything_about_your_circumstances_that_makes_dealing_with_this_harder';
    expect(longKey.length).toBeGreaterThan(TOPIC_KEY_MAX_LENGTH);

    const members = narrowTopicMembers({ questionKeys: [longKey], dataSlotKeys: [longKey] });

    expect(members.questionKeys).toEqual([longKey]);
    expect(members.dataSlotKeys).toEqual([longKey]);
  });

  it('still bounds a key that no realistic minter would produce', () => {
    const absurd = 'x'.repeat(MEMBER_KEY_MAX_LENGTH + 50);
    expect(narrowTopicMembers({ questionKeys: [absurd] }).questionKeys[0]).toHaveLength(
      MEMBER_KEY_MAX_LENGTH
    );
  });
});

describe('narrowConditionalTopicsSettings — the opening follow-up allowance (G03)', () => {
  it('is off by default, so the opening probes exactly as it always has', () => {
    const s = narrowConditionalTopicsSettings({});
    expect(s.limitOpeningProbes).toBe(false);
    // The number is what an author gets when they turn it ON — never what they run today.
    expect(s.maxOpeningProbes).toBe(1);
  });

  it('keeps zero, because "never follow up" is a real setting here', () => {
    // Unlike `sessionBudgetSeconds`, 0 is not how this is turned off — the switch beside it is.
    // Clamping 0 up to 1 would silently reinstate the probe the author just removed.
    expect(narrowConditionalTopicsSettings({ maxOpeningProbes: 0 }).maxOpeningProbes).toBe(0);
  });

  it('clamps to the ceiling and rounds a fractional allowance', () => {
    expect(narrowConditionalTopicsSettings({ maxOpeningProbes: 99 }).maxOpeningProbes).toBe(
      MAX_OPENING_PROBES_CEILING
    );
    expect(narrowConditionalTopicsSettings({ maxOpeningProbes: -2 }).maxOpeningProbes).toBe(0);
    expect(narrowConditionalTopicsSettings({ maxOpeningProbes: 1.6 }).maxOpeningProbes).toBe(2);
  });

  it('falls back to the default for anything that is not a number', () => {
    expect(narrowConditionalTopicsSettings({ maxOpeningProbes: 'one' }).maxOpeningProbes).toBe(1);
    expect(narrowConditionalTopicsSettings({ limitOpeningProbes: 'yes' }).limitOpeningProbes).toBe(
      false
    );
  });
});

describe('narrowConditionalTopicsSettings — the opening turn backstop (F17.36)', () => {
  it('is off by default, so no existing version starts closing its opening early', () => {
    expect(narrowConditionalTopicsSettings({}).maxOpeningTurns).toBe(0);
  });

  it('keeps a real limit, rounded', () => {
    expect(narrowConditionalTopicsSettings({ maxOpeningTurns: 12 }).maxOpeningTurns).toBe(12);
    expect(narrowConditionalTopicsSettings({ maxOpeningTurns: 11.4 }).maxOpeningTurns).toBe(11);
  });

  it('clamps to the ceiling', () => {
    expect(narrowConditionalTopicsSettings({ maxOpeningTurns: 999 }).maxOpeningTurns).toBe(
      MAX_OPENING_TURNS_CEILING
    );
  });

  it('reads anything unusable as OFF, never as a limit of one turn', () => {
    // The direction is the point. A limit of 1 would close every opening on its first turn, so a
    // negative, a NaN or a string must land on "no limit" rather than on the smallest limit.
    expect(narrowConditionalTopicsSettings({ maxOpeningTurns: -5 }).maxOpeningTurns).toBe(0);
    expect(narrowConditionalTopicsSettings({ maxOpeningTurns: 'ten' }).maxOpeningTurns).toBe(0);
    expect(narrowConditionalTopicsSettings({ maxOpeningTurns: NaN }).maxOpeningTurns).toBe(0);
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

  it('keeps a budget-dropped exclusion as its own reason, not as an agent decision', () => {
    // The distinction the record exists for: "there was no time" points an author at the setting,
    // "the agent did not pick it" points them at the criteria.
    const p = narrowInterviewPlan({
      ...valid,
      excluded: [{ key: 'talent', source: 'budget', rationale: 'over budget' }],
    });
    expect(p?.excluded[0]?.source).toBe('budget');
  });

  it('round-trips the budget the plan was fitted to and what it cost (C7b)', () => {
    const p = narrowInterviewPlan({ ...valid, budgetSeconds: 600, estimatedSeconds: 548 });
    expect(p).toMatchObject({ budgetSeconds: 600, estimatedSeconds: 548 });
  });

  it('omits both figures on a plan made without a budget', () => {
    // Absent, never `0`: a plan that predates budgets and a plan fitted to nothing must not read
    // the same on the admin surface.
    expect(narrowInterviewPlan(valid)).not.toHaveProperty('budgetSeconds');
    expect(narrowInterviewPlan({ ...valid, estimatedSeconds: 548 })).not.toHaveProperty(
      'estimatedSeconds'
    );
  });
});

describe('narrowInterviewPlan — forcedClose (F17.36)', () => {
  const base = {
    v: 1,
    topics: [],
    excluded: [],
    checkTopicKey: null,
    confidence: 0.8,
    source: 'llm',
    respondentMessage: '',
    decidedAtTurn: 9,
    decidedAt: '2026-09-02T10:00:00.000Z',
  };

  it('is absent on an ordinary plan, so a forced close and a finished opening never blur', () => {
    expect(narrowInterviewPlan(base)?.forcedClose).toBeUndefined();
  });

  it('reads back the turn, the limit and the uncovered members', () => {
    const plan = narrowInterviewPlan({
      ...base,
      forcedClose: {
        atTurn: 14,
        limitTurns: 12,
        uncovered: { dataSlotKeys: ['diagnostic_routing'], questionKeys: ['opening_handoff'] },
      },
    });

    expect(plan?.forcedClose).toEqual({
      atTurn: 14,
      limitTurns: 12,
      uncovered: { dataSlotKeys: ['diagnostic_routing'], questionKeys: ['opening_handoff'] },
    });
  });

  it('drops an unreadable record rather than fabricating one with zeroes', () => {
    // "This interview was forced" is a claim about the instrument. Inventing it from a malformed
    // blob would show an authoring fault on the session viewer that never happened.
    expect(narrowInterviewPlan({ ...base, forcedClose: 'yes' })?.forcedClose).toBeUndefined();
    expect(narrowInterviewPlan({ ...base, forcedClose: null })?.forcedClose).toBeUndefined();
  });

  it('survives a record whose uncovered lists are missing', () => {
    // Bounded on write, but read defensively: an empty list is a coherent record ("we know it was
    // forced, we no longer know on what"), and refusing it would lose the fact entirely.
    expect(
      narrowInterviewPlan({ ...base, forcedClose: { atTurn: 3, limitTurns: 3 } })?.forcedClose
    ).toEqual({ atTurn: 3, limitTurns: 3, uncovered: { dataSlotKeys: [], questionKeys: [] } });
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
      gaps: [
        {
          sourceQuote: 'Use judgement for respondents outside these categories.',
          explanation: 'Too vague to test mechanically — no data slot captures "judgement".',
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
    expect(set?.gaps[0]).toEqual({
      sourceQuote: 'Use judgement for respondents outside these categories.',
      explanation: 'Too vague to test mechanically — no data slot captures "judgement".',
    });
    expect(set?.maxConditionalTopics).toBe(3);
    expect(set?.fromDocument).toBe(true);
  });

  it('defaults gaps to an empty array when absent (pre-Phase-2 drafts)', () => {
    const { gaps: _gaps, ...withoutGaps } = stored();
    const set = narrowProposedTopicSet(withoutGaps);
    expect(set?.gaps).toEqual([]);
  });

  it('drops a gap missing a source quote or explanation rather than keeping an ungrounded one', () => {
    const set = narrowProposedTopicSet(
      stored({
        gaps: [
          { sourceQuote: '', explanation: 'No quote to trace this to.' },
          { sourceQuote: 'Some clause.', explanation: '' },
          { sourceQuote: 'Kept clause.', explanation: 'Kept explanation.' },
        ],
      })
    );
    expect(set?.gaps).toEqual([{ sourceQuote: 'Kept clause.', explanation: 'Kept explanation.' }]);
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
});

/**
 * C7 — the session time budget.
 *
 * These settings decide how long a respondent is asked to spend, from a stored JSON blob nobody
 * validates on the way in. The narrowing is the only thing between a fat-fingered value and an
 * interview that silently stops adapting.
 */
describe('narrowConditionalTopicsSettings — time budget (C7)', () => {
  it('defaults to no budget, so nothing changes for a version that predates it', () => {
    const s = narrowConditionalTopicsSettings({});
    expect(s.sessionBudgetSeconds).toBe(0);
    expect(s.secondsPerQuestionType).toEqual({});
    expect(s.secondsPerDataSlot).toBe(DEFAULT_SECONDS_PER_DATA_SLOT);
  });

  it('reads 0 as OFF rather than clamping it up to the floor', () => {
    // The distinction the whole setting turns on. Clamping 0 up to 30s would invent a budget the
    // author never asked for and start dropping topics.
    expect(narrowConditionalTopicsSettings({ sessionBudgetSeconds: 0 }).sessionBudgetSeconds).toBe(
      0
    );
    expect(narrowConditionalTopicsSettings({ sessionBudgetSeconds: -5 }).sessionBudgetSeconds).toBe(
      0
    );
  });

  it('clamps a real budget into the legal range', () => {
    expect(narrowConditionalTopicsSettings({ sessionBudgetSeconds: 5 }).sessionBudgetSeconds).toBe(
      MIN_SESSION_BUDGET_SECONDS
    );
    expect(
      narrowConditionalTopicsSettings({ sessionBudgetSeconds: 999_999 }).sessionBudgetSeconds
    ).toBe(MAX_SESSION_BUDGET_SECONDS);
    expect(
      narrowConditionalTopicsSettings({ sessionBudgetSeconds: 600.4 }).sessionBudgetSeconds
    ).toBe(600);
  });

  it('falls back to no budget for a value that is not a number at all', () => {
    expect(
      narrowConditionalTopicsSettings({ sessionBudgetSeconds: 'ten' }).sessionBudgetSeconds
    ).toBe(0);
  });

  it('DROPS an unusable per-type override rather than costing that type at nothing', () => {
    // A type costed at zero makes every topic using it look free, which is the one failure a time
    // budget cannot survive.
    const s = narrowConditionalTopicsSettings({
      secondsPerQuestionType: { likert: 0, free_text: -3, numeric: 'x', matrix: 12 },
    });
    expect(s.secondsPerQuestionType).toEqual({ matrix: 12 });
  });

  it('clamps and rounds the per-type overrides it keeps', () => {
    const s = narrowConditionalTopicsSettings({
      secondsPerQuestionType: { likert: 8.6, free_text: 99_999 },
    });
    expect(s.secondsPerQuestionType.likert).toBe(9);
    expect(s.secondsPerQuestionType.free_text).toBe(MAX_SECONDS_PER_ITEM);
  });

  it('ignores a non-object override map', () => {
    expect(
      narrowConditionalTopicsSettings({ secondsPerQuestionType: [1, 2] }).secondsPerQuestionType
    ).toEqual({});
  });
});

describe('narrowProposedTopicSet — the F17.23 additions', () => {
  /** A minimal well-formed stored draft with one always-run topic and one conditional. */
  function stored(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      topics: [
        {
          key: 'opening',
          label: 'Opening',
          phase: 'opening',
          criteria: null,
          depth: 'full',
          members: { questionKeys: ['q1', 'q2', 'q3', 'q4'], dataSlotKeys: [] },
          rationale: 'Gathers the signal.',
        },
        {
          key: 'pipeline',
          label: 'Pipeline',
          phase: 'conditional',
          criteria: 'They named deals stalling.',
          depth: 'light',
          members: { questionKeys: ['q5', 'q6', 'q7'], dataSlotKeys: [] },
          rationale: 'Routed.',
        },
      ],
      gaps: [],
      summary: 'Read from the routing tab.',
      fromDocument: true,
      generatedAt: '2026-08-25T00:00:00.000Z',
      ...overrides,
    };
  }

  describe('light depth on an always-run topic is corrected, not obeyed', () => {
    it('sets an opening proposed as light back to full, and names it', () => {
      const topics = stored().topics.map((t) =>
        t.key === 'opening' ? { ...t, depth: 'light' } : t
      );
      const set = narrowProposedTopicSet(stored({ topics }));

      expect(set?.topics.find((t) => t.key === 'opening')?.depth).toBe('full');
      // Corrected AND reported — a silent fix would leave the admin unable to learn that their
      // document's wording invited a proposal that drops questions.
      expect(set?.depthCorrectedKeys).toEqual(['opening']);
    });

    it.each(['core', 'closing'])('corrects a light %s topic too', (phase) => {
      const topics = stored().topics.map((t) =>
        t.key === 'opening' ? { ...t, phase, depth: 'light' } : t
      );
      const set = narrowProposedTopicSet(stored({ topics }));

      expect(set?.topics.find((t) => t.key === 'opening')?.depth).toBe('full');
      expect(set?.depthCorrectedKeys).toEqual(['opening']);
    });

    it('leaves a light conditional topic alone and reports no correction', () => {
      const set = narrowProposedTopicSet(stored());

      expect(set?.topics.find((t) => t.key === 'pipeline')?.depth).toBe('light');
      expect(set?.depthCorrectedKeys).toBeUndefined();
    });
  });

  describe('fallbackTopicKeys and checkTopicPreference', () => {
    it('carries both through when the analyst proposed them', () => {
      const set = narrowProposedTopicSet(
        stored({ fallbackTopicKeys: ['pipeline'], checkTopicPreference: ['pipeline'] })
      );

      expect(set?.fallbackTopicKeys).toEqual(['pipeline']);
      expect(set?.checkTopicPreference).toEqual(['pipeline']);
    });

    it('omits them entirely when the document said nothing', () => {
      const set = narrowProposedTopicSet(stored());

      // Absent, not empty — the same discipline as maxConditionalTopics, so a default never lands
      // where the author's silence was.
      expect(set?.fallbackTopicKeys).toBeUndefined();
      expect(set?.checkTopicPreference).toBeUndefined();
    });

    it('filters for membership BEFORE capping, so a stale key does not cost a valid one', () => {
      // Capping first spends the budget on keys about to be discarded: one stale key ahead of five
      // valid ones would keep only four.
      const many = Array.from({ length: 6 }, (_, i) => ({
        key: `t${i}`,
        label: `T${i}`,
        phase: 'conditional',
        criteria: 'c',
        depth: 'full',
        members: { questionKeys: [`q${i}`], dataSlotKeys: [] },
        rationale: 'r',
      }));
      const set = narrowProposedTopicSet(
        stored({
          topics: many,
          fallbackTopicKeys: ['ghost', 't0', 't1', 't2', 't3', 't4'],
        })
      );

      expect(set?.fallbackTopicKeys).toEqual(['t0', 't1', 't2', 't3', 't4']);
    });

    it('drops a key the proposal itself does not carry', () => {
      const set = narrowProposedTopicSet(
        stored({ fallbackTopicKeys: ['pipeline', 'not_a_topic'], checkTopicPreference: ['ghost'] })
      );

      expect(set?.fallbackTopicKeys).toEqual(['pipeline']);
      expect(set?.checkTopicPreference).toBeUndefined();
    });
  });
});

// ── Mid-interview triggers (F17.31a) ─────────────────────────────────────────

describe('narrowTopicTrigger', () => {
  it('reads a well-formed trigger', () => {
    expect(
      narrowTopicTrigger({
        condition: 'The partner mentions a food safety incident',
        cues: ['food safety', 'environmental health'],
        sourceQuote: 'A food safety incident, complaint or environmental health visit',
      })
    ).toEqual({
      condition: 'The partner mentions a food safety incident',
      cues: ['food safety', 'environmental health'],
      sourceQuote: 'A food safety incident, complaint or environmental health visit',
    });
  });

  it('is null for the ordinary case — no column value at all', () => {
    // Every topic authored before this shipped, and every topic scoped from the opening. This is a
    // read-path narrow precisely so none of them needed backfilling.
    expect(narrowTopicTrigger(null)).toBeNull();
    expect(narrowTopicTrigger(undefined)).toBeNull();
  });

  it('drops a trigger with no condition, cues or not', () => {
    // Words to listen for, with nothing to confirm, say only that some words matter — which is not
    // a record of what the document asked for.
    expect(narrowTopicTrigger({ cues: ['abuse'] })).toBeNull();
    expect(narrowTopicTrigger({ condition: '   ', cues: ['abuse'] })).toBeNull();
  });

  it('survives a malformed blob rather than throwing', () => {
    expect(narrowTopicTrigger('not an object')).toBeNull();
    expect(narrowTopicTrigger({ condition: 'They mention arrears', cues: 'not a list' })).toEqual({
      condition: 'They mention arrears',
      cues: [],
    });
  });

  it('omits sourceQuote entirely when the document did not supply one', () => {
    const trigger = narrowTopicTrigger({ condition: 'Hand-authored', cues: [] });
    expect(trigger).not.toBeNull();
    expect(trigger && 'sourceQuote' in trigger).toBe(false);
  });

  it('caps the cue list and each cue, and drops duplicates', () => {
    const trigger = narrowTopicTrigger({
      condition: 'They mention arrears',
      cues: [
        'arrears',
        'arrears',
        'x'.repeat(200),
        ...Array.from({ length: 20 }, (_, i) => `c${i}`),
      ],
    });
    expect(trigger?.cues.length).toBeLessThanOrEqual(MAX_TRIGGER_CUES);
    expect(trigger?.cues.filter((c) => c === 'arrears')).toHaveLength(1);
    expect(trigger?.cues.every((c) => c.length <= TRIGGER_CUE_MAX_LENGTH)).toBe(true);
  });
});

describe('narrowProposedTopicSet — a recorded trigger', () => {
  function storedWith(trigger: unknown) {
    return {
      v: 1,
      topics: [
        {
          key: 'abuse',
          label: 'Domestic abuse',
          phase: 'conditional',
          criteria: 'The opening indicates the applicant is fleeing abuse.',
          depth: 'full',
          members: { questionKeys: ['q1'], dataSlotKeys: [] },
          rationale: 'Added on disclosure.',
          trigger,
        },
      ],
      gaps: [],
      summary: 'Read from the document.',
      fromDocument: true,
      generatedAt: '2026-08-26T10:00:00.000Z',
    };
  }

  it('carries the trigger onto the reviewable proposal', () => {
    const set = narrowProposedTopicSet(
      storedWith({ condition: 'They disclose abuse at any stage', cues: ['abuse'] })
    );
    expect(set?.topics[0]?.trigger?.condition).toBe('They disclose abuse at any stage');
  });

  it('drops an unreadable trigger without discarding the topic', () => {
    // A malformed trigger is the absence of a record, not a reason to throw away a proposal an
    // admin is waiting on.
    const set = narrowProposedTopicSet(storedWith({ cues: ['abuse'] }));
    expect(set?.topics).toHaveLength(1);
    expect(set?.topics[0]?.trigger).toBeUndefined();
  });
});

describe('narrowConditionalTopicsSettings — early topic seating (F17.36)', () => {
  it('is off by default, with defaults that would be safe if it were on', () => {
    const s = narrowConditionalTopicsSettings({});
    expect(s.earlyTopicSeating).toBe(false);
    expect(s.earlySeatingFloor).toBe(0.6);
    // Above `minConfidence` (0.6): deciding on less evidence must mean deciding less readily.
    expect(s.earlySeatingMinConfidence).toBe(0.85);
    expect(s.earlySeatingMinConfidence).toBeGreaterThanOrEqual(s.minConfidence);
    expect(s.maxEarlySeatedTopics).toBe(1);
    expect(s.maxRoutingDecisionsPerTurn).toBe(1);
  });

  it('never lets the floor reach zero', () => {
    // A floor of zero would let the very first turn seat a topic — a decision over an empty
    // transcript wearing the language of a considered one.
    expect(narrowConditionalTopicsSettings({ earlySeatingFloor: 0 }).earlySeatingFloor).toBe(
      MIN_EARLY_SEATING_FLOOR
    );
    expect(narrowConditionalTopicsSettings({ earlySeatingFloor: -1 }).earlySeatingFloor).toBe(
      MIN_EARLY_SEATING_FLOOR
    );
  });

  it('clamps the caps to at least one, never zero', () => {
    // A cap of zero is a feature switched on that can never act — which is the failure this
    // codebase has already shipped once. The switch is how it is turned off.
    expect(narrowConditionalTopicsSettings({ maxEarlySeatedTopics: 0 }).maxEarlySeatedTopics).toBe(
      1
    );
    expect(
      narrowConditionalTopicsSettings({ maxRoutingDecisionsPerTurn: 0 }).maxRoutingDecisionsPerTurn
    ).toBe(1);
  });

  it('falls back to the defaults for anything unusable', () => {
    const s = narrowConditionalTopicsSettings({
      earlyTopicSeating: 'yes',
      earlySeatingFloor: 'high',
      maxEarlySeatedTopics: null,
    });
    expect(s.earlyTopicSeating).toBe(false);
    expect(s.earlySeatingFloor).toBe(0.6);
    expect(s.maxEarlySeatedTopics).toBe(1);
  });
});

describe('narrowEarlySeating (F17.36)', () => {
  const seat = {
    key: 'pipeline',
    depth: 'full',
    confidence: 0.93,
    rationale: 'they said deals stall',
    respondentReason: 'you mentioned deals stalling',
    atTurn: 3,
  };

  it('reads back a stored record', () => {
    const early = narrowEarlySeating({
      v: 1,
      seated: [seat],
      deferred: [],
      lastPassAtTurn: 3,
      evidenceKey: 'e1',
      overCap: false,
    });

    expect(early?.seated).toEqual([seat]);
    expect(early?.evidenceKey).toBe('e1');
  });

  it('returns null for anything unreadable, which means "nothing was seated early"', () => {
    // The OPPOSITE direction to `narrowInterviewPlan`, deliberately: a corrupt plan widens scope
    // because withholding questions is a wrong result, while a corrupt early record just means the
    // interview decides at the end, the way it always did.
    expect(narrowEarlySeating(null)).toBeNull();
    expect(narrowEarlySeating({ v: 2, seated: [seat] })).toBeNull();
    expect(narrowEarlySeating('nonsense')).toBeNull();
  });

  it('drops a seat with no key and de-duplicates by key', () => {
    const early = narrowEarlySeating({
      v: 1,
      seated: [seat, { ...seat, rationale: 'a duplicate' }, { ...seat, key: '' }],
    });
    expect(early?.seated).toHaveLength(1);
  });

  it('survives a record missing everything but its version', () => {
    expect(narrowEarlySeating({ v: 1 })).toEqual({
      v: 1,
      seated: [],
      deferred: [],
      lastPassAtTurn: 0,
      evidenceKey: '',
      overCap: false,
    });
  });
});
