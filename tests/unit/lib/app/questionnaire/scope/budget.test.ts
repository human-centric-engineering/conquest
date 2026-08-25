/**
 * Unit test: the interview time cost model (C7).
 *
 * The model exists because `maxConditionalTopics` was standing in for duration and cannot do the
 * job — a topic of ten likerts and a topic of three cost a respondent wildly different amounts of
 * attention. So the assertions that matter are the ones a count could not make: that two topics
 * with the same number of members can cost different amounts, that a `light` topic costs what it
 * will actually ask, and that the mandatory floor is subtracted before anything is allocated.
 *
 * The worked example at the end has the SHAPE of the pilot client derivation but invented item counts —
 * the real workbook is deliberately kept out of this repo, and reproducing its figures here would
 * mean fabricating the client's question set.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_SECONDS_PER_TYPE,
  alwaysTopicSeconds,
  estimateTopicCosts,
  formatSeconds,
  itemSeconds,
  matrixRowCount,
  plannedSeconds,
  routedAllowanceSeconds,
  topicSeconds,
} from '@/lib/app/questionnaire/scope/budget';
import { applyGuardrails } from '@/lib/app/questionnaire/scope/guardrails';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  narrowConditionalTopicsSettings,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';

const settings: ConditionalTopicsSettings = DEFAULT_CONDITIONAL_TOPICS_SETTINGS;

function topic(key: string, phase: TopicPhase, questionKeys: string[]): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: '',
    phase,
    criteria: '',
    depth: 'full',
    members: { questionKeys, dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
  };
}

describe('itemSeconds', () => {
  it('prices each type from the defaults', () => {
    const seconds = itemSeconds(
      [
        { key: 'a', type: 'likert' },
        { key: 'b', type: 'free_text' },
        { key: 'c', type: 'boolean' },
      ],
      [],
      settings
    );
    expect(seconds.byQuestionKey.get('a')).toBe(DEFAULT_SECONDS_PER_TYPE.likert);
    expect(seconds.byQuestionKey.get('b')).toBe(DEFAULT_SECONDS_PER_TYPE.free_text);
    expect(seconds.byQuestionKey.get('c')).toBe(DEFAULT_SECONDS_PER_TYPE.boolean);
  });

  it('prices a matrix per row — it is N ratings wearing one prompt', () => {
    // Pricing a 12-row grid as one item is how it ends up looking cheaper than the three likerts
    // beside it, which is exactly backwards.
    const seconds = itemSeconds([{ key: 'grid', type: 'matrix', rowCount: 6 }], [], settings);
    expect(seconds.byQuestionKey.get('grid')).toBe(DEFAULT_SECONDS_PER_TYPE.matrix * 6);
  });

  it('honours a per-version override', () => {
    const custom = narrowConditionalTopicsSettings({ secondsPerQuestionType: { likert: 20 } });
    const seconds = itemSeconds([{ key: 'a', type: 'likert' }], [], custom);
    expect(seconds.byQuestionKey.get('a')).toBe(20);
  });

  it('falls back to free text for an unrecognised stored type', () => {
    // The most expensive guess, on purpose: under-costing an unknown is how a budget silently
    // over-fills.
    const seconds = itemSeconds([{ key: 'a', type: 'wat' }], [], settings);
    expect(seconds.byQuestionKey.get('a')).toBe(DEFAULT_SECONDS_PER_TYPE.free_text);
  });

  it('prices data slots as open questions', () => {
    const seconds = itemSeconds([], ['goal'], settings);
    expect(seconds.byDataSlotKey.get('goal')).toBe(settings.secondsPerDataSlot);
  });
});

describe('topicSeconds', () => {
  const seconds = itemSeconds(
    [
      { key: 'q1', type: 'likert' },
      { key: 'q2', type: 'likert' },
      { key: 'q3', type: 'likert' },
      { key: 'long', type: 'free_text' },
    ],
    [],
    settings
  );

  it('costs a full topic as the sum of its members', () => {
    const t = topic('data', 'conditional', ['q1', 'q2', 'q3']);
    expect(topicSeconds(t, 'full', seconds)).toBe(DEFAULT_SECONDS_PER_TYPE.likert * 3);
  });

  it('sees that two same-sized topics can cost different amounts', () => {
    // The whole reason a count is not a length.
    const cheap = topic('cheap', 'conditional', ['q1', 'q2']);
    const dear = topic('dear', 'conditional', ['q1', 'long']);
    expect(topicSeconds(cheap, 'full', seconds)).toBeLessThan(topicSeconds(dear, 'full', seconds));
  });

  it('costs a light topic as the members it will actually ask', () => {
    const t = topic('data', 'conditional', ['q1', 'q2', 'q3']);
    // LIGHT_DEPTH_MEMBER_COUNT is 2, so a three-member topic sampled lightly costs two items.
    expect(topicSeconds(t, 'light', seconds)).toBe(DEFAULT_SECONDS_PER_TYPE.likert * 2);
  });

  it('prices the light sample through the weights the interview will use', () => {
    // A light topic asks its highest-weight members. If the cost model picked different ones, a
    // budget would be built on an interview that never happens.
    const t = topic('mixed', 'conditional', ['q1', 'q2', 'long']);
    const weights = {
      byQuestionKey: new Map([
        ['q1', 0.1],
        ['q2', 0.1],
        ['long', 9],
      ]),
    };
    expect(topicSeconds(t, 'light', seconds, weights)).toBe(
      DEFAULT_SECONDS_PER_TYPE.free_text + DEFAULT_SECONDS_PER_TYPE.likert
    );
  });

  it('costs a member with no price at nothing rather than throwing', () => {
    const t = topic('ghost', 'conditional', ['nope']);
    expect(topicSeconds(t, 'full', seconds)).toBe(0);
  });
});

describe('alwaysTopicSeconds and routedAllowanceSeconds', () => {
  const seconds = itemSeconds(
    [
      { key: 'open', type: 'free_text' },
      { key: 'core', type: 'likert' },
      { key: 'close', type: 'free_text' },
      { key: 'cond', type: 'likert' },
    ],
    [],
    settings
  );
  const topics = [
    topic('opening', 'opening', ['open']),
    topic('core', 'core', ['core']),
    topic('closing', 'closing', ['close']),
    topic('routed', 'conditional', ['cond']),
  ];
  const costs = estimateTopicCosts(topics, seconds);

  it('counts only the always-run phases in the floor', () => {
    expect(alwaysTopicSeconds(topics, costs)).toBe(45 + 8 + 45);
  });

  it('leaves the budget minus the floor to allocate', () => {
    expect(routedAllowanceSeconds(600, 98)).toBe(502);
  });

  it('has nothing to allocate when there is no budget', () => {
    expect(routedAllowanceSeconds(0, 98)).toBe(0);
  });

  it('never returns a negative allowance', () => {
    // An over-floor budget is a broken configuration, but the arithmetic must still be sane —
    // `validateConditionalTopics` is what tells the author about it.
    expect(routedAllowanceSeconds(60, 300)).toBe(0);
  });
});

describe('formatSeconds', () => {
  it('reads the way an author writes a duration', () => {
    expect(formatSeconds(8)).toBe('8s');
    expect(formatSeconds(100)).toBe('1m 40s');
    expect(formatSeconds(600)).toBe('10m');
    expect(formatSeconds(0)).toBe('0s');
    expect(formatSeconds(-5)).toBe('0s');
  });
});

/**
 * A worked example: a budget that admits three topics and not a fourth.
 *
 * The shape of the pilot client derivation — a mandatory floor spent before any routing decision, then
 * an allowance that a specific number of routed topics happens to fit — but with **invented item
 * counts**, because the real workbook is deliberately kept out of this repo. So this asserts the
 * PROPERTIES the model must have, not that any particular instrument comes to any particular
 * number. Reproducing the client's figures here would mean fabricating their question set.
 */
describe('a worked example: floor, allowance, and what fits', () => {
  const questions = [
    // The always-run interview: an opening of four open questions, two core ratings, a close.
    ...['open1', 'open2', 'open3', 'open4'].map((key) => ({ key, type: 'free_text' as const })),
    { key: 'core1', type: 'likert' as const },
    { key: 'core2', type: 'likert' as const },
    { key: 'close1', type: 'free_text' as const },
    // Four routed topics: three expensive, one cheap.
    ...Array.from({ length: 10 }, (_, i) => ({ key: `big1_${i}`, type: 'likert' as const })),
    ...Array.from({ length: 10 }, (_, i) => ({ key: `big2_${i}`, type: 'likert' as const })),
    ...Array.from({ length: 10 }, (_, i) => ({ key: `big3_${i}`, type: 'likert' as const })),
    ...Array.from({ length: 3 }, (_, i) => ({ key: `small_${i}`, type: 'likert' as const })),
  ];
  const topics = [
    topic('opening', 'opening', ['open1', 'open2', 'open3', 'open4']),
    topic('core', 'core', ['core1', 'core2']),
    topic('closing', 'closing', ['close1']),
    ...['big1', 'big2', 'big3'].map((key) =>
      topic(
        key,
        'conditional',
        Array.from({ length: 10 }, (_, i) => `${key}_${i}`)
      )
    ),
    topic(
      'small',
      'conditional',
      Array.from({ length: 3 }, (_, i) => `small_${i}`)
    ),
  ];

  // 490s is chosen so the three expensive topics fit (240s of a 249s allowance) but the blind-spot
  // check does not — the margin the workbook's own arithmetic forgets about.
  const budgeted = narrowConditionalTopicsSettings({ sessionBudgetSeconds: 490 });
  const seconds = itemSeconds(questions, [], budgeted);
  const costs = estimateTopicCosts(topics, seconds);
  const floor = alwaysTopicSeconds(topics, costs);
  const allowance = routedAllowanceSeconds(490, floor);

  it('spends the always-run phases before anything is allocated', () => {
    // 4 open questions at 45s + 2 likerts at 8s + 1 close at 45s.
    expect(floor).toBe(45 * 5 + 8 * 2);
    expect(allowance).toBe(490 - floor);
  });

  it('admits three of the expensive topics but not a fourth', () => {
    // This is the property `maxConditionalTopics` could never express: the answer depends on what
    // the topics COST, not how many there are.
    const three = costs.get('big1')!.full + costs.get('big2')!.full + costs.get('big3')!.full;
    expect(three).toBeLessThanOrEqual(allowance);
    expect(three + costs.get('small')!.full).toBeGreaterThan(allowance);
  });

  it('does not treat the blind-spot check as free', () => {
    // The finding f17-followups.md §1 records: the workbook's own arithmetic omits the check
    // topic's two items, so a plan sized without them overruns by exactly that much.
    const check = costs.get('small')!.light;
    expect(check).toBe(DEFAULT_SECONDS_PER_TYPE.likert * 2);
    const three = costs.get('big1')!.full + costs.get('big2')!.full + costs.get('big3')!.full;
    expect(three + check).toBeGreaterThan(allowance);
  });

  it('and the guardrails act on it: the third topic is dropped to pay for the check', () => {
    // The cost model and the enforcement, end to end (C7b). The planner asked for all three
    // expensive topics; they fit the allowance on their own and stop fitting the moment the
    // blind-spot check is priced in — so the lowest-ranked one goes.
    const plan = applyGuardrails({
      topics,
      proposed: [
        { key: 'big1', rationale: 'a' },
        { key: 'big2', rationale: 'b' },
        { key: 'big3', rationale: 'c' },
      ],
      rules: { include: new Set(), exclude: new Set(), reasonByTopic: new Map() },
      settings: { ...budgeted, enabled: true, maxConditionalTopics: 3, includeCheckTopic: true },
      confidence: 0.9,
      source: 'llm',
      respondentMessage: '',
      decidedAtTurn: 3,
      decidedAt: '2026-08-13T00:00:00.000Z',
      budget: { budgetSeconds: 490, costs },
    });

    expect(plan.topics.filter((t) => t.source === 'llm').map((t) => t.key)).toEqual([
      'big1',
      'big2',
    ]);
    expect(plan.checkTopicKey).toBe('big3');
    expect(plan.excluded.find((e) => e.key === 'big3')).toBeUndefined();
    expect(plan.estimatedSeconds).toBeLessThanOrEqual(490);
  });
});

describe('matrixRowCount', () => {
  it('counts the rows a grid asks a respondent to rate', () => {
    const rows = matrixRowCount({
      rows: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      scale: { min: 1, max: 5 },
    });
    expect(rows).toBe(3);
  });

  it.each([null, undefined, {}, { rows: 'nonsense' }, 42])(
    'falls back to one row for %p rather than pricing the grid at nothing',
    (config) => {
      expect(matrixRowCount(config)).toBe(1);
    }
  );
});

describe('plannedSeconds', () => {
  const costs = new Map([
    ['pipeline', { full: 100, light: 10 }],
    ['talent', { full: 60, light: 8 }],
  ]);

  it('prices each seated topic at the depth it was seated at', () => {
    // The whole reason the plan carries a depth: a light topic is a sample, not the area.
    expect(
      plannedSeconds(
        [
          { key: 'pipeline', depth: 'full' },
          { key: 'talent', depth: 'light' },
        ],
        costs
      )
    ).toBe(108);
  });

  it('charges nothing for a topic it has no price for', () => {
    expect(plannedSeconds([{ key: 'invented', depth: 'full' }], costs)).toBe(0);
  });

  it('is zero for an interview that seated nothing conditional', () => {
    expect(plannedSeconds([], costs)).toBe(0);
  });
});
