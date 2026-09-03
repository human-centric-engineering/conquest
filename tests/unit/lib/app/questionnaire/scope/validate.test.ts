import { describe, it, expect } from 'vitest';

import { hasScopeErrors, validateConditionalTopics } from '@/lib/app/questionnaire/scope/validate';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';

function topic(key: string, phase: TopicPhase, overrides: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [`${key}_q`] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
    ...overrides,
  };
}

function settings(overrides: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...overrides };
}

/** A coherent setup: an opening, a core, and three conditionals. */
function healthy() {
  return {
    topics: [
      topic('open', 'opening'),
      topic('spine', 'core'),
      topic('cond_a', 'conditional'),
      topic('cond_b', 'conditional'),
      topic('cond_c', 'conditional'),
    ],
    settings: settings({ maxConditionalTopics: 2 }),
    allQuestionKeys: ['open_q', 'spine_q', 'cond_a_q', 'cond_b_q', 'cond_c_q'],
    allDataSlotKeys: [],
  };
}

function codes(input: Parameters<typeof validateConditionalTopics>[0]): string[] {
  return validateConditionalTopics(input).map((i) => i.code);
}

describe('validateConditionalTopics', () => {
  it('says nothing about a coherent setup', () => {
    expect(validateConditionalTopics(healthy())).toEqual([]);
  });

  describe('orphaned questions — the check that matters', () => {
    it('is an ERROR when the feature is on, because the question can never be asked', () => {
      const issues = validateConditionalTopics({
        ...healthy(),
        allQuestionKeys: [...healthy().allQuestionKeys, 'belongs_nowhere'],
      });

      const orphan = issues.find((i) => i.code === 'orphaned_questions');
      expect(orphan?.severity).toBe('error');
      expect(hasScopeErrors(issues)).toBe(true);
    });

    it('is a WARNING when the feature is off — the thing to see BEFORE flipping the switch', () => {
      const issues = validateConditionalTopics({
        ...healthy(),
        settings: settings({ enabled: false }),
        allQuestionKeys: [...healthy().allQuestionKeys, 'belongs_nowhere'],
      });

      expect(issues.find((i) => i.code === 'orphaned_questions')?.severity).toBe('warning');
      expect(hasScopeErrors(issues)).toBe(false);
    });

    it('says nothing when no topics exist at all — that is an unconfigured version, not a fault', () => {
      expect(
        codes({
          topics: [],
          settings: settings({ enabled: false }),
          allQuestionKeys: ['q1', 'q2'],
        })
      ).not.toContain('orphaned_questions');
    });

    it('reports orphaned data slots too', () => {
      expect(codes({ ...healthy(), allDataSlotKeys: ['unclaimed'] })).toContain(
        'orphaned_data_slots'
      );
    });
  });

  describe('per-topic', () => {
    it('flags a conditional topic with no criteria as an error when enabled', () => {
      const issues = validateConditionalTopics({
        ...healthy(),
        topics: [...healthy().topics, topic('cond_d', 'conditional', { criteria: '   ' })],
        allQuestionKeys: [...healthy().allQuestionKeys, 'cond_d_q'],
      });

      const found = issues.find((i) => i.code === 'conditional_without_criteria');
      expect(found?.severity).toBe('error');
      expect(found?.topicKey).toBe('cond_d');
    });

    it('does not flag an always-run topic for having no criteria', () => {
      expect(codes(healthy())).not.toContain('conditional_without_criteria');
    });

    it('flags a topic containing nothing', () => {
      expect(
        codes({
          ...healthy(),
          topics: [
            ...healthy().topics,
            topic('hollow', 'core', { members: { dataSlotKeys: [], questionKeys: [] } }),
          ],
        })
      ).toContain('empty_topic');
    });
  });

  describe('whole setup', () => {
    it('errors when nothing gathers the signal', () => {
      const base = healthy();
      const issues = validateConditionalTopics({
        ...base,
        topics: base.topics.filter((t) => t.phase !== 'opening'),
        allQuestionKeys: base.allQuestionKeys.filter((k) => k !== 'open_q'),
      });

      expect(issues.find((i) => i.code === 'no_opening_topic')?.severity).toBe('error');
    });

    it('warns when nothing is conditional — there is no decision to make', () => {
      const base = healthy();
      const conditionals = base.topics.filter((t) => t.phase === 'conditional').map((t) => t.key);
      expect(
        codes({
          ...base,
          topics: base.topics.filter((t) => t.phase !== 'conditional'),
          allQuestionKeys: base.allQuestionKeys.filter(
            (k) => !conditionals.some((c) => k.startsWith(c))
          ),
        })
      ).toContain('no_conditional_topics');
    });

    it('warns when the limit is at least the number of candidates, so every one always runs', () => {
      expect(codes({ ...healthy(), settings: settings({ maxConditionalTopics: 3 }) })).toContain(
        'cap_exceeds_candidates'
      );
    });

    it('warns when there are too few conditionals to leave one out for the blind-spot check', () => {
      const base = healthy();
      const dropped = ['cond_b', 'cond_c'];
      expect(
        codes({
          ...base,
          topics: base.topics.filter((t) => !dropped.includes(t.key)),
          allQuestionKeys: base.allQuestionKeys.filter(
            (k) => !dropped.some((d) => k.startsWith(d))
          ),
          settings: settings({ maxConditionalTopics: 1, includeCheckTopic: true }),
        })
      ).toContain('check_topic_impossible');
    });

    it('stays quiet about setup while the feature is off', () => {
      const base = healthy();
      const found = codes({
        ...base,
        topics: base.topics.filter((t) => t.phase !== 'opening'),
        allQuestionKeys: base.allQuestionKeys.filter((k) => k !== 'open_q'),
        settings: settings({ enabled: false }),
      });
      expect(found).not.toContain('no_opening_topic');
    });
  });

  describe('dangling references', () => {
    it('warns about a fallback or blind-spot preference naming a missing topic', () => {
      const found = codes({
        ...healthy(),
        settings: settings({ fallbackTopicKeys: ['gone'], checkTopicPreference: ['also_gone'] }),
      });
      expect(found).toContain('fallback_unknown_topic');
      expect(found).toContain('check_preference_unknown_topic');
    });

    it('warns when an always-run topic is named as a fallback — it can never be chosen', () => {
      expect(
        codes({ ...healthy(), settings: settings({ fallbackTopicKeys: ['spine'] }) })
      ).toContain('always_topic_named_as_choice');
    });
  });

  it('orders errors before warnings', () => {
    const issues = validateConditionalTopics({
      ...healthy(),
      allQuestionKeys: [...healthy().allQuestionKeys, 'orphan'],
      settings: settings({ maxConditionalTopics: 3, fallbackTopicKeys: ['gone'] }),
    });

    const firstWarning = issues.findIndex((i) => i.severity === 'warning');
    const lastError = issues.map((i) => i.severity).lastIndexOf('error');
    expect(lastError).toBeLessThan(firstWarning);
  });
});

/**
 * C7 — budget coherence.
 *
 * A budget that cannot cover the mandatory floor is not a tight interview, it is a broken one: the
 * planner has nothing to spend, so the instrument silently stops adapting and every respondent gets
 * the always-on questions alone. These are the findings that make that visible before launch.
 */
describe('validateConditionalTopics — time budget (C7)', () => {
  const topics: Topic[] = [
    topic('opening', 'opening', { members: { questionKeys: ['q0'], dataSlotKeys: [] } }),
    topic('data', 'conditional', { members: { questionKeys: ['q1'], dataSlotKeys: [] } }),
    topic('people', 'conditional', { members: { questionKeys: ['q2'], dataSlotKeys: [] } }),
  ];
  const base = {
    topics,
    allQuestionKeys: ['q0', 'q1', 'q2'],
    allDataSlotKeys: [] as string[],
  };

  it('says nothing about time when no budget is set', () => {
    const issues = validateConditionalTopics({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 0 }),
      seconds: { always: 500, cheapestConditional: 100 },
    });
    expect(issues.map((i) => i.code)).not.toContain('budget_below_floor');
  });

  it('errors when the always-on questions already exceed the budget', () => {
    const issues = validateConditionalTopics({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 200 }),
      seconds: { always: 260, cheapestConditional: 40 },
    });
    const found = issues.find((i) => i.code === 'budget_below_floor');
    expect(found?.severity).toBe('error');
    expect(found?.message).toContain('260s');
  });

  it('warns when the leftover cannot fit even the cheapest topic', () => {
    // Not an error: the configuration is coherent, it just never routes. An author may be mid-edit.
    const issues = validateConditionalTopics({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 300 }),
      seconds: { always: 280, cheapestConditional: 40 },
    });
    const found = issues.find((i) => i.code === 'budget_admits_no_topic');
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('20s is left');
  });

  it('is quiet when the budget comfortably admits topics', () => {
    const issues = validateConditionalTopics({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 600 }),
      seconds: { always: 260, cheapestConditional: 40 },
    });
    expect(issues.map((i) => i.code)).not.toContain('budget_below_floor');
    expect(issues.map((i) => i.code)).not.toContain('budget_admits_no_topic');
  });

  it('says nothing about time when the caller supplied no costs', () => {
    // The module is pure and cannot price questions itself; a caller without types still gets every
    // other finding rather than a wrong one.
    const issues = validateConditionalTopics({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 60 }),
    });
    expect(issues.map((i) => i.code)).not.toContain('budget_below_floor');
  });
});

describe('validateConditionalTopics — duplicate membership (F17.15)', () => {
  it('says nothing when every member is claimed once', () => {
    expect(codes(healthy())).not.toContain('duplicate_membership');
  });

  it('names the two topics that claim a shared question, and what it costs', () => {
    const issues = validateConditionalTopics({
      ...healthy(),
      topics: [
        topic('open', 'opening'),
        topic('spine', 'core', {
          members: { dataSlotKeys: [], questionKeys: ['spine_q', 'open_q'] },
        }),
        topic('cond_a', 'conditional'),
        topic('cond_b', 'conditional'),
        topic('cond_c', 'conditional'),
      ],
    });

    const dup = issues.find((i) => i.code === 'duplicate_membership');
    expect(dup?.severity).toBe('warning');
    expect(dup?.message).toContain('"open_q"');
    expect(dup?.message).toContain('"open"');
    expect(dup?.message).toContain('"spine"');
    // The consequence an author cannot see anywhere else: the cost panel over-prices the interview,
    // because `alwaysTopicSeconds` sums per-topic costs and charges the shared member twice.
    expect(dup?.message).toContain('priced higher than it costs');
  });

  it('reports the duplicate even while Conditional Topics is off — the time estimate is wrong today', () => {
    const issues = validateConditionalTopics({
      ...healthy(),
      settings: settings({ enabled: false }),
      topics: [
        topic('spine', 'core'),
        topic('other', 'core', { members: { dataSlotKeys: [], questionKeys: ['spine_q'] } }),
      ],
      allQuestionKeys: ['spine_q', 'other_q'],
    });

    expect(issues.map((i) => i.code)).toContain('duplicate_membership');
  });

  it('aggregates rather than reporting forty findings for a copied topic', () => {
    const members = { dataSlotKeys: [], questionKeys: ['a', 'b', 'c'] };
    const issues = validateConditionalTopics({
      ...healthy(),
      topics: [topic('one', 'core', { members }), topic('two', 'core', { members })],
      allQuestionKeys: ['a', 'b', 'c'],
    });

    const dups = issues.filter((i) => i.code === 'duplicate_membership');
    expect(dups).toHaveLength(1);
    expect(dups[0].message).toContain('3 questions');
  });

  it('reports duplicated data slots separately from duplicated questions', () => {
    const members = { dataSlotKeys: ['s1'], questionKeys: ['a'] };
    const issues = validateConditionalTopics({
      ...healthy(),
      topics: [topic('one', 'core', { members }), topic('two', 'core', { members })],
      allQuestionKeys: ['a'],
      allDataSlotKeys: ['s1'],
    });

    const dups = issues.filter((i) => i.code === 'duplicate_membership');
    expect(dups).toHaveLength(2);
    expect(dups.map((d) => d.message).join(' ')).toContain('data slot "s1"');
  });
});

describe('validateConditionalTopics — comparability passthrough (F17.15)', () => {
  const scoring = {
    scales: [{ key: 'trust', name: 'Trust' }],
    items: [
      { source: 'question' as const, ref: 'spine_q', scaleKey: 'trust', weight: 1, reverse: false },
      {
        source: 'question' as const,
        ref: 'cond_a_q',
        scaleKey: 'trust',
        weight: 1,
        reverse: false,
      },
    ],
    bands: [],
    method: 'mean' as const,
  };

  it('runs no comparability check when the version does not score', () => {
    expect(codes(healthy())).not.toContain('scale_split_by_scope');
  });

  it('merges the scale findings into the same sorted list', () => {
    const issues = validateConditionalTopics({ ...healthy(), scoring });

    expect(issues.map((i) => i.code)).toContain('scale_split_by_scope');
    // Errors first is the contract the Topics tab and the launch gate both rely on.
    const severities = issues.map((i) => i.severity);
    expect([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1))).toEqual(
      severities
    );
  });

  it('prices the scale against the routed allowance derived from the budget and the floor', () => {
    const issues = validateConditionalTopics({
      ...healthy(),
      settings: settings({ maxConditionalTopics: 3, sessionBudgetSeconds: 300 }),
      scoring: {
        ...scoring,
        items: [
          { source: 'question', ref: 'cond_a_q', scaleKey: 'trust', weight: 1, reverse: false },
          { source: 'question', ref: 'cond_b_q', scaleKey: 'trust', weight: 1, reverse: false },
        ],
      },
      // Floor 250 of a 300s budget leaves 50 — less than the 120s the scale's two topics need.
      seconds: { always: 250, cheapestConditional: 60, byTopicKey: { cond_a: 60, cond_b: 60 } },
    });

    expect(issues.map((i) => i.code)).toContain('scale_never_whole');
  });
});

/**
 * The opening's follow-up allowance (G03 / F17.17).
 *
 * Both findings exist for the same reason: the allowance can be switched on and change nothing,
 * and neither reason is visible from the tab it is switched on from.
 */
describe('validateConditionalTopics — the opening follow-up allowance', () => {
  const codes = (issues: ReturnType<typeof validateConditionalTopics>) => issues.map((i) => i.code);

  it('says nothing while the allowance is off', () => {
    const issues = validateConditionalTopics({ ...healthy(), maxDataSlotAttempts: 1 });
    expect(codes(issues)).not.toContain('opening_probe_limit_inert');
    expect(codes(issues)).not.toContain('opening_probe_limit_moot');
  });

  it('flags an opening with no data slot — the limit rations conversational follow-ups', () => {
    // `healthy()`'s opening topic is built from a QUESTION. The interviewer re-asks data slots, not
    // form questions, so there is nothing here for the allowance to bound.
    const issues = validateConditionalTopics({
      ...healthy(),
      settings: settings({ limitOpeningProbes: true }),
      maxDataSlotAttempts: 3,
    });
    expect(codes(issues)).toContain('opening_probe_limit_inert');
  });

  it('flags an opening whose data-slot keys no longer resolve', () => {
    // A topic may still name a slot an author deleted. A limit rationing a slot that does not exist
    // rations nothing, and reads on the tab exactly like one that does.
    const base = healthy();
    const issues = validateConditionalTopics({
      ...base,
      topics: [
        topic('open', 'opening', { members: { dataSlotKeys: ['gone'], questionKeys: [] } }),
        ...base.topics.slice(1),
      ],
      settings: settings({ limitOpeningProbes: true }),
      allQuestionKeys: base.allQuestionKeys.filter((k) => k !== 'open_q'),
      allDataSlotKeys: ['still_here'],
      maxDataSlotAttempts: 3,
    });
    expect(codes(issues)).toContain('opening_probe_limit_inert');
  });

  it('flags a limit that cannot bind because the interview never follows up', () => {
    // The per-slot cap lives on a different tab and defaults to 1 — one ask, no follow-up ever. An
    // author rationing follow-ups there is rationing something that does not happen.
    const base = healthy();
    const issues = validateConditionalTopics({
      ...base,
      topics: [
        topic('open', 'opening', { members: { dataSlotKeys: ['sig'], questionKeys: [] } }),
        ...base.topics.slice(1),
      ],
      settings: settings({ limitOpeningProbes: true }),
      allQuestionKeys: base.allQuestionKeys.filter((k) => k !== 'open_q'),
      allDataSlotKeys: ['sig'],
      maxDataSlotAttempts: 1,
    });
    expect(codes(issues)).toContain('opening_probe_limit_moot');
    // One finding, not both — an opening that HAS a data slot is not also inert.
    expect(codes(issues)).not.toContain('opening_probe_limit_inert');
  });

  it('names the stored per-slot value rather than assuming it is 1', () => {
    // A 0 in the column (an import, a direct write) would otherwise be reported as a 1, sending the
    // admin to look for a number that is not on their screen.
    const base = healthy();
    const issues = validateConditionalTopics({
      ...base,
      topics: [
        topic('open', 'opening', { members: { dataSlotKeys: ['sig'], questionKeys: [] } }),
        ...base.topics.slice(1),
      ],
      settings: settings({ limitOpeningProbes: true }),
      allQuestionKeys: base.allQuestionKeys.filter((k) => k !== 'open_q'),
      allDataSlotKeys: ['sig'],
      maxDataSlotAttempts: 0,
    });
    const moot = issues.find((i) => i.code === 'opening_probe_limit_moot');
    expect(moot?.message).toContain('is 0 on the Settings tab');
  });

  it('says nothing when the allowance can actually bind', () => {
    const base = healthy();
    const issues = validateConditionalTopics({
      ...base,
      topics: [
        topic('open', 'opening', { members: { dataSlotKeys: ['sig'], questionKeys: [] } }),
        ...base.topics.slice(1),
      ],
      settings: settings({ limitOpeningProbes: true }),
      allQuestionKeys: base.allQuestionKeys.filter((k) => k !== 'open_q'),
      allDataSlotKeys: ['sig'],
      maxDataSlotAttempts: 3,
    });
    expect(codes(issues).filter((c) => c.startsWith('opening_probe_'))).toHaveLength(0);
  });

  it('stays silent about the follow-up allowance while Conditional Topics itself is off', () => {
    const base = healthy();
    const issues = validateConditionalTopics({
      ...base,
      settings: settings({ enabled: false, limitOpeningProbes: true }),
      maxDataSlotAttempts: 3,
    });
    expect(codes(issues).filter((c) => c.startsWith('opening_probe_'))).toHaveLength(0);
  });
});

describe('validateConditionalTopics — light depth on an always-run topic (F17.23)', () => {
  /** An always-run topic big enough that `light` actually drops members. */
  function bigAlways(phase: TopicPhase, depth: 'full' | 'light') {
    return topic('open', phase, {
      depth,
      members: { dataSlotKeys: [], questionKeys: ['q1', 'q2', 'q3', 'q4'] },
    });
  }

  function withTopic(t: Topic, enabled: boolean) {
    return {
      topics: [t, topic('cond_a', 'conditional')],
      settings: settings({ enabled }),
      allQuestionKeys: ['q1', 'q2', 'q3', 'q4', 'cond_a_q'],
      allDataSlotKeys: [],
    };
  }

  it('is an error on the opening once the feature is on', () => {
    const issues = validateConditionalTopics(withTopic(bigAlways('opening', 'light'), true));
    const found = issues.find((i) => i.code === 'light_depth_on_always_topic');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
    expect(found?.topicKey).toBe('open');
    // Names the real numbers, because "set it to Full" without them is not checkable.
    expect(found?.message).toContain('2 of its 4 questions');
  });

  it('is only a warning while the feature is off — the same shape as the orphan check', () => {
    const issues = validateConditionalTopics(withTopic(bigAlways('opening', 'light'), false));
    expect(issues.find((i) => i.code === 'light_depth_on_always_topic')?.severity).toBe('warning');
  });

  it('fires on core and closing too — they run for everyone as well', () => {
    for (const phase of ['core', 'closing'] as const) {
      expect(codes(withTopic(bigAlways(phase, 'light'), true))).toContain(
        'light_depth_on_always_topic'
      );
    }
  });

  it('says nothing about a conditional topic — light is what conditional depth is for', () => {
    const cond = topic('cond_a', 'conditional', {
      depth: 'light',
      members: { dataSlotKeys: [], questionKeys: ['q1', 'q2', 'q3', 'q4'] },
    });
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), cond],
      settings: settings(),
      allQuestionKeys: ['open_q', 'q1', 'q2', 'q3', 'q4'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).not.toContain('light_depth_on_always_topic');
  });

  it('says nothing when the topic is too small to lose anything', () => {
    // `membersAtDepth` early-returns at <= LIGHT_DEPTH_MEMBER_COUNT, so light and full are the
    // same run here. Flagging it would be noise about a setting that changed nothing.
    const small = topic('spine', 'core', {
      depth: 'light',
      members: { dataSlotKeys: [], questionKeys: ['q1', 'q2'] },
    });
    expect(codes(withTopic(small, true))).not.toContain('light_depth_on_always_topic');
  });

  it('fires on the data-slot side independently — depth trims each kind separately', () => {
    const slotHeavy = topic('spine', 'core', {
      depth: 'light',
      members: { dataSlotKeys: ['s1', 's2', 's3'], questionKeys: ['q1'] },
    });
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), slotHeavy, topic('cond_a', 'conditional')],
      settings: settings(),
      allQuestionKeys: ['open_q', 'q1', 'cond_a_q'],
      allDataSlotKeys: ['s1', 's2', 's3'],
    });
    expect(issues.map((i) => i.code)).toContain('light_depth_on_always_topic');
  });

  it('names the data slots, not the questions, when only the slots were trimmed', () => {
    // The check fires on either kind, so the message has to follow. Reporting "asks only 1 of its
    // 1 questions" on a topic whose questions all fit is self-contradictory, and it points the
    // admin at the half that is fine.
    const slotHeavyOpening = topic('open', 'opening', {
      depth: 'light',
      members: { dataSlotKeys: ['s1', 's2', 's3', 's4', 's5'], questionKeys: ['q1'] },
    });
    const issues = validateConditionalTopics({
      topics: [slotHeavyOpening, topic('cond_a', 'conditional')],
      settings: settings(),
      allQuestionKeys: ['q1', 'cond_a_q'],
      allDataSlotKeys: ['s1', 's2', 's3', 's4', 's5'],
    });

    const found = issues.find((i) => i.code === 'light_depth_on_always_topic');
    expect(found?.message).toContain('3 of its data slots are never filled');
    expect(found?.message).not.toContain('of its 1 questions');
  });
});

// ── Mid-interview triggers (F17.31a) ─────────────────────────────────────────

describe('validateConditionalTopics — recorded triggers', () => {
  const trigger = {
    condition: 'The applicant discloses that they are fleeing abuse',
    cues: ['abuse', 'fleeing'],
    sourceQuote: 'If the applicant discloses, at any stage, that they are fleeing abuse',
  };

  it('reports that a triggered topic is still decided at the end of the opening', () => {
    // The whole point of storing a trigger before anything fires it: the admin reviewing the
    // routing is told, on the topic, that the instrument asked for something the interview will
    // not do. Nothing here is misconfigured, so it is a warning and there is no edit that clears it.
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), topic('abuse', 'conditional', { trigger })],
      settings: settings(),
      allQuestionKeys: ['open_q', 'abuse_q'],
      allDataSlotKeys: [],
    });

    const found = issues.find((i) => i.code === 'trigger_settled_at_opening');
    expect(found?.severity).toBe('warning');
    expect(found?.topicKey).toBe('abuse');
    expect(found?.message).toContain('The applicant discloses that they are fleeing abuse');
    expect(found?.message).toContain('only included when that is already clear');
    expect(hasScopeErrors(issues)).toBe(false);
  });

  it('reports it whether or not the feature is enabled, because it describes the document', () => {
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), topic('abuse', 'conditional', { trigger })],
      settings: settings({ enabled: false }),
      allQuestionKeys: ['open_q', 'abuse_q'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).toContain('trigger_settled_at_opening');
  });

  it('says nothing at all about a topic with no trigger', () => {
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), topic('plain', 'conditional')],
      settings: settings(),
      allQuestionKeys: ['open_q', 'plain_q'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).not.toContain('trigger_settled_at_opening');
    expect(issues.map((i) => i.code)).not.toContain('trigger_on_always_topic');
    expect(issues.map((i) => i.code)).not.toContain('trigger_without_cues');
  });

  it('flags a trigger on a topic everyone is asked, which can never change anything', () => {
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening', { trigger }), topic('cond', 'conditional')],
      settings: settings(),
      allQuestionKeys: ['open_q', 'cond_q'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).toContain('trigger_on_always_topic');
    // ...and NOT the settled-at-opening warning alongside it. On an always-run topic that message
    // is not merely redundant, it is false — it says the topic is included only when the condition
    // is clear by the end of the opening, and an always-run topic is included for everyone
    // regardless. Two warnings contradicting each other on one topic key teach an admin to
    // distrust the panel, so each trigger raises exactly one of the two.
    expect(issues.map((i) => i.code)).not.toContain('trigger_settled_at_opening');
  });

  it('says nothing about a trigger with no words to listen for', () => {
    // Deliberately NOT a finding. It was one, and it was unactionable: cues are written by the
    // analyst from the document, the topic editor shows a trigger read-only, and nothing reads a
    // cue yet — so the only honest response an admin had was "I know, and I cannot". A panel
    // carrying a warning like that gets skimmed, and the warnings beside it are the ones that
    // matter. It returns as an ERROR when an evaluator reads cues and a re-analysis is the fix.
    const issues = validateConditionalTopics({
      topics: [
        topic('open', 'opening'),
        topic('abuse', 'conditional', { trigger: { ...trigger, cues: [] } }),
      ],
      settings: settings(),
      allQuestionKeys: ['open_q', 'abuse_q'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).not.toContain('trigger_without_cues');
  });

  it('still reports what the questionnaire asked for on that same cue-less trigger', () => {
    // Dropping the cue warning must not take the trigger's real finding with it: the gap between
    // what the document asked for and what the interview does is unchanged by whether the analyst
    // managed to name any cues.
    const issues = validateConditionalTopics({
      topics: [
        topic('open', 'opening'),
        topic('abuse', 'conditional', { trigger: { ...trigger, cues: [] } }),
      ],
      settings: settings(),
      allQuestionKeys: ['open_q', 'abuse_q'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).toContain('trigger_settled_at_opening');
  });

  it('says nothing about cues when the trigger has them either', () => {
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), topic('abuse', 'conditional', { trigger })],
      settings: settings(),
      allQuestionKeys: ['open_q', 'abuse_q'],
      allDataSlotKeys: [],
    });
    expect(issues.map((i) => i.code)).not.toContain('trigger_without_cues');
  });
});

describe('opening_member_uncoverable (F17.36)', () => {
  // The gate is all-or-nothing, so ONE member nobody can cover means no plan is ever made — for
  // every respondent, silently. Session CPY3-1C6S was exactly this.
  const open = (members: { dataSlotKeys: string[]; questionKeys: string[] }) =>
    topic('open', 'opening', { members });

  function run(
    over: {
      members?: { dataSlotKeys: string[]; questionKeys: string[] };
      memberText?: {
        byQuestionKey?: Record<string, string>;
        byDataSlotKey?: Record<string, string>;
      };
      maxOpeningTurns?: number;
      enabled?: boolean;
    } = {}
  ) {
    const members = over.members ?? { dataSlotKeys: [], questionKeys: ['opening_handoff'] };
    return validateConditionalTopics({
      topics: [open(members), topic('cond_a', 'conditional'), topic('cond_b', 'conditional')],
      settings: settings({
        enabled: over.enabled ?? true,
        maxOpeningTurns: over.maxOpeningTurns ?? 0,
      }),
      allQuestionKeys: [...members.questionKeys, 'cond_a_q', 'cond_b_q'],
      allDataSlotKeys: members.dataSlotKeys,
      ...(over.memberText ? { memberText: over.memberText } : {}),
    }).filter((i) => i.code === 'opening_member_uncoverable');
  }

  it('flags a question slot whose prompt asks nothing', () => {
    const issues = run({
      memberText: {
        byQuestionKey: {
          opening_handoff: 'Thanks. Now let us move on to the areas that matter most for you.',
        },
      },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('opening_handoff');
  });

  it('does not flag a real question, whether it ends in a question mark or not', () => {
    // The heuristic has to survive an imperative prompt, which is how half the good questions in
    // any instrument are written.
    expect(
      run({ memberText: { byQuestionKey: { opening_handoff: 'What is slowing you down?' } } })
    ).toHaveLength(0);
    expect(
      run({
        memberText: {
          byQuestionKey: { opening_handoff: 'Describe the last deal that stalled on you.' },
        },
      })
    ).toHaveLength(0);
    expect(
      run({
        memberText: { byQuestionKey: { opening_handoff: 'Walk me through a typical week.' } },
      })
    ).toHaveLength(0);
  });

  it("flags a data slot whose description records the interview's own behaviour", () => {
    const issues = run({
      members: { dataSlotKeys: ['diagnostic_routing'], questionKeys: [] },
      memberText: {
        byDataSlotKey: {
          diagnostic_routing:
            "Routing. Records the interviewer's routing decision for this session.",
        },
      },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('diagnostic_routing');
  });

  it('does not flag a data slot that is about the respondent', () => {
    // "agent" as a job title must survive. An instrument for estate agents would otherwise have
    // its whole opening flagged.
    expect(
      run({
        members: { dataSlotKeys: ['agency_size'], questionKeys: [] },
        memberText: {
          byDataSlotKey: { agency_size: 'Agency size. How many agents work at their branch.' },
        },
      })
    ).toHaveLength(0);
  });

  it('points at the backstop when there is none, and reports it when there is', () => {
    const text = {
      byQuestionKey: { opening_handoff: 'Thanks for that. Here is what happens next.' },
    };

    expect(run({ memberText: text })[0]?.message).toContain('longest the opening may run');
    expect(run({ memberText: text, maxOpeningTurns: 12 })[0]?.message).toContain('after 12 turns');
  });

  it('says nothing when the caller passes no wording, and nothing while the feature is off', () => {
    // Every other input to this module is optional the same way: a caller without it gets every
    // other finding rather than a fabricated one.
    expect(run({})).toHaveLength(0);
    expect(
      run({
        enabled: false,
        memberText: { byQuestionKey: { opening_handoff: 'Here is what happens next.' } },
      })
    ).toHaveLength(0);
  });
});

describe('early topic seating (F17.36)', () => {
  function run(over: Partial<ConditionalTopicsSettings> = {}, conditionals = 3) {
    return validateConditionalTopics({
      topics: [
        topic('open', 'opening'),
        ...Array.from({ length: conditionals }, (_, i) => topic(`cond_${i}`, 'conditional')),
      ],
      settings: settings({ earlyTopicSeating: true, ...over }),
      allQuestionKeys: ['open_q', ...Array.from({ length: conditionals }, (_, i) => `cond_${i}_q`)],
      allDataSlotKeys: [],
    }).map((i) => i.code);
  }

  it('says nothing while the switch is off, however the numbers are set', () => {
    const codes = run({ earlyTopicSeating: false, earlySeatingMinConfidence: 0.1 });
    expect(codes).not.toContain('early_confidence_below_floor');
    expect(codes).not.toContain('cap_hierarchy_inverted');
  });

  it('flags an early bar looser than the full decision needs', () => {
    // Backwards: deciding on LESS of the conversation would then be the EASIER gate to pass, which
    // produces exactly the thin-evidence seats the floor exists to prevent.
    expect(run({ minConfidence: 0.8, earlySeatingMinConfidence: 0.6 })).toContain(
      'early_confidence_below_floor'
    );
    expect(run({ minConfidence: 0.6, earlySeatingMinConfidence: 0.85 })).not.toContain(
      'early_confidence_below_floor'
    );
  });

  it('flags caps that do not nest', () => {
    // Per turn ≤ per opening ≤ per interview. An inner cap above an outer one expresses an intent
    // the runtime cannot honour: it is simply never reached.
    expect(
      run({ maxRoutingDecisionsPerTurn: 3, maxEarlySeatedTopics: 1, maxConditionalTopics: 5 })
    ).toContain('cap_hierarchy_inverted');
    expect(
      run({ maxRoutingDecisionsPerTurn: 1, maxEarlySeatedTopics: 4, maxConditionalTopics: 2 })
    ).toContain('cap_hierarchy_inverted');
    expect(
      run({ maxRoutingDecisionsPerTurn: 1, maxEarlySeatedTopics: 2, maxConditionalTopics: 3 })
    ).not.toContain('cap_hierarchy_inverted');
  });

  it('flags the switch turned on with nothing it could ever choose', () => {
    expect(run({}, 0)).toContain('early_seating_without_conditional_topics');
    expect(run({}, 3)).not.toContain('early_seating_without_conditional_topics');
  });

  it('reports every finding as advisory, never as a launch blocker', () => {
    // These are configuration opinions. An interview configured this way still runs coherently, so
    // refusing a launch over one would block a client on a judgement call.
    const issues = validateConditionalTopics({
      topics: [topic('open', 'opening'), topic('cond_a', 'conditional')],
      settings: settings({
        earlyTopicSeating: true,
        minConfidence: 0.9,
        earlySeatingMinConfidence: 0.2,
        maxRoutingDecisionsPerTurn: 9,
        maxEarlySeatedTopics: 1,
      }),
      allQuestionKeys: ['open_q', 'cond_a_q'],
      allDataSlotKeys: [],
    }).filter((i) => i.code.startsWith('early_') || i.code === 'cap_hierarchy_inverted');

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });
});
