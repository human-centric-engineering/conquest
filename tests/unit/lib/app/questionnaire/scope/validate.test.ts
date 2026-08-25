import { describe, it, expect } from 'vitest';

import { hasScopeErrors, validateAdaptiveScope } from '@/lib/app/questionnaire/scope/validate';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
  type ScopeRule,
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
    ...overrides,
  };
}

function settings(overrides: Partial<AdaptiveScopeSettings> = {}): AdaptiveScopeSettings {
  return { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true, ...overrides };
}

function rule(overrides: Partial<ScopeRule> = {}): ScopeRule {
  return {
    id: 'r1',
    dataSlotKey: 'known_slot',
    operator: 'exists',
    value: null,
    action: 'include',
    topicKey: 'cond_a',
    ordinal: 0,
    ...overrides,
  };
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

function codes(input: Parameters<typeof validateAdaptiveScope>[0]): string[] {
  return validateAdaptiveScope(input).map((i) => i.code);
}

describe('validateAdaptiveScope', () => {
  it('says nothing about a coherent setup', () => {
    expect(validateAdaptiveScope(healthy())).toEqual([]);
  });

  describe('orphaned questions — the check that matters', () => {
    it('is an ERROR when the feature is on, because the question can never be asked', () => {
      const issues = validateAdaptiveScope({
        ...healthy(),
        allQuestionKeys: [...healthy().allQuestionKeys, 'belongs_nowhere'],
      });

      const orphan = issues.find((i) => i.code === 'orphaned_questions');
      expect(orphan?.severity).toBe('error');
      expect(hasScopeErrors(issues)).toBe(true);
    });

    it('is a WARNING when the feature is off — the thing to see BEFORE flipping the switch', () => {
      const issues = validateAdaptiveScope({
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
      const issues = validateAdaptiveScope({
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
      const issues = validateAdaptiveScope({
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
    it('warns about a rule pointing at a topic that no longer exists', () => {
      expect(
        codes({ ...healthy(), settings: settings({ rules: [rule({ topicKey: 'gone' })] }) })
      ).toContain('rule_unknown_topic');
    });

    it('warns about a rule testing a data slot that no longer exists', () => {
      expect(
        codes({
          ...healthy(),
          allDataSlotKeys: ['other'],
          settings: settings({ rules: [rule({ dataSlotKey: 'vanished' })] }),
        })
      ).toContain('rule_unknown_data_slot');
    });

    it('does not check data-slot references when the caller supplied no inventory', () => {
      const { allDataSlotKeys: _drop, ...rest } = healthy();
      expect(
        codes({ ...rest, settings: settings({ rules: [rule({ dataSlotKey: 'unknown' })] }) })
      ).not.toContain('rule_unknown_data_slot');
    });

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

    /**
     * A hard rule aimed at an always-run topic is the same no-op reached from the other direction:
     * `applyGuardrails` seats and vetoes within the conditional set, and `resolveScope` puts every
     * other phase in scope regardless. It is worth its own finding because a rule is where a silent
     * no-op costs most — it reads as a certainty ("never ask compliance of a non-licence-holder")
     * and does nothing to anybody, on every interview, with no other surface reporting it.
     */
    it.each<TopicPhase>(['core', 'opening', 'closing'])(
      'warns when a rule names the %s topic "spine", which is asked either way',
      (phase) => {
        const base = healthy();
        expect(
          codes({
            ...base,
            topics: base.topics.map((t) => (t.key === 'spine' ? topic('spine', phase) : t)),
            settings: settings({
              maxConditionalTopics: 2,
              rules: [rule({ topicKey: 'spine', action: 'exclude' })],
            }),
            allDataSlotKeys: ['known_slot'],
          })
        ).toContain('rule_names_always_topic');
      }
    );

    it('names the rule’s direction, so the author can find which rule to fix', () => {
      const issue = validateAdaptiveScope({
        ...healthy(),
        settings: settings({
          maxConditionalTopics: 2,
          rules: [rule({ topicKey: 'spine', action: 'include' })],
        }),
        allDataSlotKeys: ['known_slot'],
      }).find((i) => i.code === 'rule_names_always_topic');

      expect(issue?.severity).toBe('warning');
      expect(issue?.topicKey).toBe('spine');
      expect(issue?.message).toContain('includes "spine"');
    });

    it('says nothing about a rule aimed at a conditional topic', () => {
      expect(
        codes({
          ...healthy(),
          settings: settings({
            maxConditionalTopics: 2,
            rules: [rule({ topicKey: 'cond_a' })],
          }),
          allDataSlotKeys: ['known_slot'],
        })
      ).not.toContain('rule_names_always_topic');
    });
  });

  /**
   * Hard-rule reachability.
   *
   * Rules are evaluated at exactly one moment — when the opening completes and the planner runs.
   * The findings below are about a rule that reads a slot the interview has not gathered by then,
   * and the `not_exists` case is the one worth the error: absence is what a veto matches on, so an
   * ungathered slot does not make the rule inert. It makes it fire for everybody.
   */
  describe('hard-rule reachability', () => {
    /** An opening that gathers `situation`, a core that gathers `headcount`. */
    function reachable() {
      return {
        ...healthy(),
        topics: [
          topic('open', 'opening', {
            members: { dataSlotKeys: ['situation'], questionKeys: ['open_q'] },
          }),
          topic('spine', 'core', {
            members: { dataSlotKeys: ['headcount'], questionKeys: ['spine_q'] },
          }),
          topic('cond_a', 'conditional', {
            members: { dataSlotKeys: ['partners'], questionKeys: ['cond_a_q'] },
          }),
          topic('cond_b', 'conditional'),
          topic('cond_c', 'conditional'),
        ],
        allDataSlotKeys: ['situation', 'headcount', 'partners'],
      };
    }

    it('says nothing about a rule reading a slot the opening gathers', () => {
      const found = codes({
        ...reachable(),
        settings: settings({ rules: [rule({ dataSlotKey: 'situation' })] }),
      });
      expect(found).not.toContain('rule_slot_unreachable');
      expect(found).not.toContain('rule_slot_not_in_opening');
      expect(found).not.toContain('rule_veto_always_fires');
    });

    it('warns when a rule reads a slot only a conditional topic gathers', () => {
      // `partners` is gathered by cond_a, which is not in scope until the plan exists — so the rule
      // deciding whether cond_a runs is reading something only cond_a could have produced.
      expect(
        codes({
          ...reachable(),
          settings: settings({ rules: [rule({ dataSlotKey: 'partners' })] }),
        })
      ).toContain('rule_slot_unreachable');
    });

    it('warns when a rule reads a slot the core gathers — the order is not guaranteed', () => {
      const found = codes({
        ...reachable(),
        settings: settings({ rules: [rule({ dataSlotKey: 'headcount' })] }),
      });
      expect(found).toContain('rule_slot_not_in_opening');
      expect(found).not.toContain('rule_slot_unreachable');
    });

    it('ERRORS on a veto reading an ungathered slot — it excludes every respondent', () => {
      const issues = validateAdaptiveScope({
        ...reachable(),
        settings: settings({
          rules: [rule({ dataSlotKey: 'partners', operator: 'not_exists', action: 'exclude' })],
        }),
      });

      const veto = issues.find((i) => i.code === 'rule_veto_always_fires');
      expect(veto?.severity).toBe('error');
      expect(veto?.message).toContain('every respondent');
      // Not also reported as unreachable: a veto that always matches is the opposite complaint.
      expect(issues.map((i) => i.code)).not.toContain('rule_slot_unreachable');
    });

    it('downgrades the veto finding to a warning while the feature is off', () => {
      const issues = validateAdaptiveScope({
        ...reachable(),
        settings: settings({
          enabled: false,
          rules: [rule({ dataSlotKey: 'partners', operator: 'not_exists' })],
        }),
      });
      expect(issues.find((i) => i.code === 'rule_veto_always_fires')?.severity).toBe('warning');
    });

    it('stays quiet when there is no opening topic at all', () => {
      // `no_opening_topic` is the finding to fix first; one reachability warning per rule on top of
      // it would bury the thing that caused them.
      const base = reachable();
      const found = codes({
        ...base,
        topics: base.topics.filter((t) => t.phase !== 'opening'),
        settings: settings({
          rules: [rule({ dataSlotKey: 'partners', operator: 'not_exists' })],
        }),
      });
      expect(found).toContain('no_opening_topic');
      expect(found).not.toContain('rule_veto_always_fires');
      expect(found).not.toContain('rule_slot_unreachable');
    });

    it('does not pile a reachability finding onto a slot that no longer exists', () => {
      const found = codes({
        ...reachable(),
        settings: settings({ rules: [rule({ dataSlotKey: 'vanished' })] }),
      });
      expect(found).toContain('rule_unknown_data_slot');
      expect(found).not.toContain('rule_slot_unreachable');
    });
  });

  it('orders errors before warnings', () => {
    const issues = validateAdaptiveScope({
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
describe('validateAdaptiveScope — time budget (C7)', () => {
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
    const issues = validateAdaptiveScope({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 0 }),
      seconds: { always: 500, cheapestConditional: 100 },
    });
    expect(issues.map((i) => i.code)).not.toContain('budget_below_floor');
  });

  it('errors when the always-on questions already exceed the budget', () => {
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 300 }),
      seconds: { always: 280, cheapestConditional: 40 },
    });
    const found = issues.find((i) => i.code === 'budget_admits_no_topic');
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('20s is left');
  });

  it('is quiet when the budget comfortably admits topics', () => {
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
      ...base,
      settings: settings({ enabled: true, sessionBudgetSeconds: 60 }),
    });
    expect(issues.map((i) => i.code)).not.toContain('budget_below_floor');
  });
});

describe('validateAdaptiveScope — duplicate membership (F17.15)', () => {
  it('says nothing when every member is claimed once', () => {
    expect(codes(healthy())).not.toContain('duplicate_membership');
  });

  it('names the two topics that claim a shared question, and what it costs', () => {
    const issues = validateAdaptiveScope({
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

  it('reports the duplicate even while Adaptive Scope is off — the time estimate is wrong today', () => {
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
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

describe('validateAdaptiveScope — comparability passthrough (F17.15)', () => {
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
    const issues = validateAdaptiveScope({ ...healthy(), scoring });

    expect(issues.map((i) => i.code)).toContain('scale_split_by_scope');
    // Errors first is the contract the Topics tab and the launch gate both rely on.
    const severities = issues.map((i) => i.severity);
    expect([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1))).toEqual(
      severities
    );
  });

  it('prices the scale against the routed allowance derived from the budget and the floor', () => {
    const issues = validateAdaptiveScope({
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
describe('validateAdaptiveScope — the opening follow-up allowance', () => {
  const codes = (issues: ReturnType<typeof validateAdaptiveScope>) => issues.map((i) => i.code);

  it('says nothing while the allowance is off', () => {
    const issues = validateAdaptiveScope({ ...healthy(), maxDataSlotAttempts: 1 });
    expect(codes(issues)).not.toContain('opening_probe_limit_inert');
    expect(codes(issues)).not.toContain('opening_probe_limit_moot');
  });

  it('flags an opening with no data slot — the limit rations conversational follow-ups', () => {
    // `healthy()`'s opening topic is built from a QUESTION. The interviewer re-asks data slots, not
    // form questions, so there is nothing here for the allowance to bound.
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
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

  it('stays silent about the follow-up allowance while Adaptive Scope itself is off', () => {
    const base = healthy();
    const issues = validateAdaptiveScope({
      ...base,
      settings: settings({ enabled: false, limitOpeningProbes: true }),
      maxDataSlotAttempts: 3,
    });
    expect(codes(issues).filter((c) => c.startsWith('opening_probe_'))).toHaveLength(0);
  });
});

describe('validateAdaptiveScope — light depth on an always-run topic (F17.23)', () => {
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
    const issues = validateAdaptiveScope(withTopic(bigAlways('opening', 'light'), true));
    const found = issues.find((i) => i.code === 'light_depth_on_always_topic');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
    expect(found?.topicKey).toBe('open');
    // Names the real numbers, because "set it to Full" without them is not checkable.
    expect(found?.message).toContain('2 of its 4 questions');
  });

  it('is only a warning while the feature is off — the same shape as the orphan check', () => {
    const issues = validateAdaptiveScope(withTopic(bigAlways('opening', 'light'), false));
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
    const issues = validateAdaptiveScope({
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
    const issues = validateAdaptiveScope({
      topics: [topic('open', 'opening'), slotHeavy, topic('cond_a', 'conditional')],
      settings: settings(),
      allQuestionKeys: ['open_q', 'q1', 'cond_a_q'],
      allDataSlotKeys: ['s1', 's2', 's3'],
    });
    expect(issues.map((i) => i.code)).toContain('light_depth_on_always_topic');
  });
});
