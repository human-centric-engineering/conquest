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
