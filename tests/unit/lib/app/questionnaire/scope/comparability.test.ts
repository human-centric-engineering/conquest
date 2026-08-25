import { describe, expect, it } from 'vitest';

import { checkScaleComparability } from '@/lib/app/questionnaire/scope/comparability';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';
import type { ScoringItem, ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

function topic(key: string, phase: TopicPhase, questionKeys: string[]): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys },
    ordinal: 0,
    source: 'seeded',
  };
}

function settings(overrides: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true, ...overrides };
}

function item(ref: string, overrides: Partial<ScoringItem> = {}): ScoringItem {
  return { source: 'question', ref, scaleKey: 'trust', weight: 1, reverse: false, ...overrides };
}

function schema(items: ScoringItem[], scaleKeys = ['trust']): ScoringSchemaContent {
  return {
    scales: scaleKeys.map((key) => ({ key, name: key.toUpperCase() })),
    items,
    bands: [],
    method: 'mean',
  };
}

/** The version's real key inventory — what separates an unowned key from a stale one. */
function inventory(questionKeys: string[], dataSlotKeys: string[] = []) {
  return { questionKeys, dataSlotKeys };
}

function codes(...args: Parameters<typeof checkScaleComparability>): string[] {
  return checkScaleComparability(...args).map((i) => i.code);
}

describe('checkScaleComparability', () => {
  it('says nothing when a version has no scoring schema worth checking', () => {
    expect(
      checkScaleComparability({
        topics: [topic('spine', 'core', ['q1'])],
        settings: settings(),
        scoring: schema([]),
      })
    ).toEqual([]);
  });

  it('says nothing when every item sits in an always-run topic', () => {
    // Nothing routing does can narrow this scale, so every respondent is scored on all of it.
    expect(
      codes({
        topics: [topic('spine', 'core', ['q1', 'q2']), topic('cond', 'conditional', ['q9'])],
        settings: settings(),
        scoring: schema([item('q1'), item('q2')]),
      })
    ).toEqual([]);
  });

  it('treats an item claimed by an always-run topic AND a conditional one as always asked', () => {
    // It is asked whether or not the conditional topic is seated, so the scale is not at risk.
    expect(
      codes({
        topics: [topic('spine', 'core', ['q1']), topic('cond', 'conditional', ['q1'])],
        settings: settings(),
        scoring: schema([item('q1')]),
      })
    ).toEqual([]);
  });

  describe('a scale routing can narrow', () => {
    it('warns that partially-assessed respondents are excluded from cohort aggregates', () => {
      const issues = checkScaleComparability({
        topics: [
          topic('spine', 'core', ['q1']),
          topic('cond_a', 'conditional', ['q2']),
          topic('cond_b', 'conditional', ['q3']),
        ],
        settings: settings({ maxConditionalTopics: 3 }),
        scoring: schema([item('q1'), item('q2'), item('q3')]),
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('scale_split_by_scope');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].message).toContain('2 conditional topics');
      expect(issues[0].message).toContain('leave those respondents out');
    });

    it('reports it even while Conditional Topics is off — the question is asked before the switch', () => {
      expect(
        codes({
          topics: [topic('spine', 'core', ['q1']), topic('cond_a', 'conditional', ['q2'])],
          settings: settings({ enabled: false, maxConditionalTopics: 3 }),
          scoring: schema([item('q1'), item('q2')]),
        })
      ).toEqual(['scale_split_by_scope']);
    });
  });

  describe('a scale no plan can ever cover', () => {
    it('warns when the scale needs more conditional topics than one interview can ask', () => {
      const issues = checkScaleComparability({
        topics: [
          topic('cond_a', 'conditional', ['q1']),
          topic('cond_b', 'conditional', ['q2']),
          topic('cond_c', 'conditional', ['q3']),
        ],
        settings: settings({ maxConditionalTopics: 2 }),
        scoring: schema([item('q1'), item('q2'), item('q3')]),
      });

      // The sharper finding replaces the softer one rather than joining it: "sometimes partial" is
      // not the news when the answer is "always partial".
      expect(issues.map((i) => i.code)).toEqual(['scale_never_whole']);
      expect(issues[0].message).toContain('3 conditional topics');
      expect(issues[0].message).toContain('at most 2');
      expect(issues[0].message).toContain('raise the limit to 3');
    });

    it('warns when the scale’s topics cannot fit the routed allowance together', () => {
      const issues = checkScaleComparability({
        topics: [topic('cond_a', 'conditional', ['q1']), topic('cond_b', 'conditional', ['q2'])],
        settings: settings({ maxConditionalTopics: 3, sessionBudgetSeconds: 300 }),
        scoring: schema([item('q1'), item('q2')]),
        seconds: { byTopicKey: { cond_a: 150, cond_b: 150 }, routedAllowance: 200 },
      });

      expect(issues.map((i) => i.code)).toEqual(['scale_never_whole']);
      expect(issues[0].message).toContain('about 300s');
      expect(issues[0].message).toContain('only 200s is left');
    });

    it('stays quiet on the budget when the topics do fit', () => {
      expect(
        codes({
          topics: [topic('cond_a', 'conditional', ['q1']), topic('cond_b', 'conditional', ['q2'])],
          settings: settings({ maxConditionalTopics: 3, sessionBudgetSeconds: 600 }),
          scoring: schema([item('q1'), item('q2')]),
          seconds: { byTopicKey: { cond_a: 150, cond_b: 150 }, routedAllowance: 400 },
        })
      ).toEqual(['scale_split_by_scope']);
    });

    it('ignores the budget arithmetic when no budget is set', () => {
      // `routedAllowance` is 0 with no budget, which would otherwise fail every scale.
      expect(
        codes({
          topics: [topic('cond_a', 'conditional', ['q1'])],
          settings: settings({ maxConditionalTopics: 3, sessionBudgetSeconds: 0 }),
          scoring: schema([item('q1')]),
          seconds: { byTopicKey: { cond_a: 150 }, routedAllowance: 0 },
        })
      ).toEqual(['scale_split_by_scope']);
    });

    it('does not count rule-included topics against the cap', () => {
      // `applyGuardrails` seats rule-includes BEFORE the cap and does not truncate them, so a plan
      // can legitimately exceed `maxConditionalTopics`. Counting them here warned that no
      // respondent is ever asked a scale every respondent is in fact asked in full.
      const rules = [
        {
          id: 'r1',
          dataSlotKey: 's',
          operator: 'exists' as const,
          value: null,
          action: 'include' as const,
          topicKey: 'cond_a',
          ordinal: 0,
        },
        {
          id: 'r2',
          dataSlotKey: 's',
          operator: 'exists' as const,
          value: null,
          action: 'include' as const,
          topicKey: 'cond_b',
          ordinal: 1,
        },
      ];

      expect(
        codes({
          topics: [
            topic('cond_a', 'conditional', ['q1']),
            topic('cond_b', 'conditional', ['q2']),
            topic('cond_c', 'conditional', ['q3']),
          ],
          settings: settings({ maxConditionalTopics: 1, rules }),
          scoring: schema([item('q1'), item('q2'), item('q3')]),
        })
      ).toEqual(['scale_split_by_scope']);
    });

    it('counts a rule-included topic against the cap again when another rule vetoes it back out', () => {
      const rules = [
        {
          id: 'r1',
          dataSlotKey: 's',
          operator: 'exists' as const,
          value: null,
          action: 'include' as const,
          topicKey: 'cond_a',
          ordinal: 0,
        },
        {
          id: 'r2',
          dataSlotKey: 's',
          operator: 'not_exists' as const,
          value: null,
          action: 'exclude' as const,
          topicKey: 'cond_a',
          ordinal: 1,
        },
      ];

      expect(
        codes({
          topics: [topic('cond_a', 'conditional', ['q1']), topic('cond_b', 'conditional', ['q2'])],
          settings: settings({ maxConditionalTopics: 1, rules }),
          scoring: schema([item('q1'), item('q2')]),
        })
      ).toEqual(['scale_never_whole']);
    });

    it('counts only unavoidable topics, so a shared item never triggers a false alarm', () => {
      // q1 is claimed by three conditional topics, so ANY one of them asks it — a plan seating one
      // covers the whole scale. Counting the topics it touches (3) would exceed the cap of 1 and
      // announce that no respondent is ever asked all of it, which is simply untrue.
      expect(
        codes({
          topics: [
            topic('cond_a', 'conditional', ['q1']),
            topic('cond_b', 'conditional', ['q1']),
            topic('cond_c', 'conditional', ['q1']),
          ],
          settings: settings({ maxConditionalTopics: 1 }),
          scoring: schema([item('q1')]),
        })
      ).toEqual(['scale_split_by_scope']);
    });
  });

  describe('an item no topic asks', () => {
    it('is an error while the feature is on, when the key really exists on the version', () => {
      const issues = checkScaleComparability({
        topics: [topic('spine', 'core', ['q1'])],
        settings: settings(),
        scoring: schema([item('q1'), item('q_orphan')]),
        inventory: inventory(['q1', 'q_orphan']),
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('scale_item_unowned');
      expect(issues[0].severity).toBe('error');
      expect(issues[0].message).toContain('"q_orphan"');
    });

    it('is only a warning while the feature is off', () => {
      const issues = checkScaleComparability({
        topics: [topic('spine', 'core', ['q1'])],
        settings: settings({ enabled: false }),
        scoring: schema([item('q_orphan')]),
        inventory: inventory(['q1', 'q_orphan']),
      });

      expect(issues[0].severity).toBe('warning');
    });

    it('is a WARNING, not an error, when the key no longer exists on the version', () => {
      // Deleting a question does not prune the scoring schema, so a stale ref is easy to acquire
      // and impossible to fix from the Topics tab. An error here would block launch AND preview
      // while pointing the admin at a surface where the key is not shown.
      const issues = checkScaleComparability({
        topics: [topic('spine', 'core', ['q1'])],
        settings: settings(),
        scoring: schema([item('q1'), item('q_deleted')]),
        inventory: inventory(['q1']),
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('scale_item_stale');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].message).toContain('scoring schema');
    });

    it('falls back to the softer finding when no inventory is supplied to check against', () => {
      // A caller that cannot prove the key exists must not raise a launch-blocking error about it.
      const issues = checkScaleComparability({
        topics: [topic('spine', 'core', ['q1'])],
        settings: settings(),
        scoring: schema([item('q_unknown')]),
      });

      expect(issues[0].code).toBe('scale_item_stale');
      expect(issues[0].severity).toBe('warning');
    });

    it('resolves a data-slot item against data-slot membership, not question membership', () => {
      const spine = topic('spine', 'core', []);
      spine.members.dataSlotKeys = ['revenue'];

      expect(
        codes({
          topics: [spine],
          settings: settings(),
          scoring: schema([item('revenue', { source: 'dataSlot' })]),
        })
      ).toEqual([]);
    });
  });

  it('checks each scale independently', () => {
    const issues = checkScaleComparability({
      topics: [topic('spine', 'core', ['q1']), topic('cond_a', 'conditional', ['q2'])],
      settings: settings({ maxConditionalTopics: 3 }),
      scoring: schema(
        [item('q1', { scaleKey: 'trust' }), item('q2', { scaleKey: 'clarity' })],
        ['trust', 'clarity']
      ),
    });

    // `trust` sits entirely in the spine; only `clarity` is exposed to routing.
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('CLARITY');
  });
});
