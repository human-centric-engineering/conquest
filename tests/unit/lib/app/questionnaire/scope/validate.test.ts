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
