import { describe, it, expect } from 'vitest';

import {
  applyGuardrails,
  chooseCheckTopic,
  plannerCandidates,
  type ApplyGuardrailsInput,
} from '@/lib/app/questionnaire/scope/guardrails';
import type { RuleOutcome } from '@/lib/app/questionnaire/scope/rules';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';

function topic(key: string, phase: TopicPhase = 'conditional', over: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: 'when it fits',
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [`${key}_q`] },
    ordinal: 0,
    source: 'seeded',
    ...over,
  };
}

function settings(over: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return {
    ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
    enabled: true,
    maxConditionalTopics: 3,
    includeCheckTopic: false,
    ...over,
  };
}

function noRules(): RuleOutcome {
  return { include: new Set(), exclude: new Set(), reasonByTopic: new Map() };
}

const TOPICS = [
  topic('open', 'opening'),
  topic('spine', 'core'),
  topic('pipeline'),
  topic('forecast'),
  topic('talent'),
  topic('data'),
  topic('close', 'closing'),
];

function input(over: Partial<ApplyGuardrailsInput> = {}): ApplyGuardrailsInput {
  return {
    topics: TOPICS,
    proposed: [],
    rules: noRules(),
    settings: settings(),
    confidence: 0.9,
    source: 'llm',
    respondentMessage: 'I want to go deeper on a few areas.',
    decidedAtTurn: 4,
    decidedAt: '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

describe('applyGuardrails — the cap', () => {
  it('trims the model’s picks to the limit', () => {
    const plan = applyGuardrails(
      input({
        proposed: [
          { key: 'pipeline', rationale: 'a' },
          { key: 'forecast', rationale: 'b' },
          { key: 'talent', rationale: 'c' },
          { key: 'data', rationale: 'd' },
        ],
        settings: settings({ maxConditionalTopics: 2 }),
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline', 'forecast']);
  });

  it('keeps the model’s own ordering — its first pick is its most confident', () => {
    const plan = applyGuardrails(
      input({
        proposed: [
          { key: 'talent', rationale: 'a' },
          { key: 'pipeline', rationale: 'b' },
        ],
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['talent', 'pipeline']);
  });

  it('never seats the same topic twice', () => {
    const plan = applyGuardrails(
      input({
        proposed: [
          { key: 'pipeline', rationale: 'a' },
          { key: 'pipeline', rationale: 'again' },
        ],
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline']);
  });
});

describe('applyGuardrails — unknown and ineligible keys', () => {
  it('drops a proposal naming a topic that does not exist', () => {
    // A planner naming something invented is exactly what this layer exists to catch.
    const plan = applyGuardrails(
      input({
        proposed: [
          { key: 'hallucinated', rationale: 'a' },
          { key: 'pipeline', rationale: 'b' },
        ],
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline']);
  });

  it('drops a proposal naming an always-run topic — there is nothing to decide about it', () => {
    const plan = applyGuardrails(input({ proposed: [{ key: 'spine', rationale: 'a' }] }));
    expect(plan.topics).toEqual([]);
  });
});

describe('applyGuardrails — hard rules', () => {
  function rules(over: Partial<RuleOutcome> = {}): RuleOutcome {
    return { ...noRules(), ...over };
  }

  it('seats a rule-included topic before the model’s picks, so the cap cannot truncate it', () => {
    const plan = applyGuardrails(
      input({
        proposed: [
          { key: 'pipeline', rationale: 'a' },
          { key: 'forecast', rationale: 'b' },
        ],
        rules: rules({
          include: new Set(['talent']),
          reasonByTopic: new Map([['talent', 'because headcount > 500']]),
        }),
        settings: settings({ maxConditionalTopics: 2 }),
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['talent', 'pipeline']);
    expect(plan.topics[0]).toMatchObject({ source: 'rule', rationale: 'because headcount > 500' });
  });

  it('never seats a rule-excluded topic, however confidently the model proposed it', () => {
    const plan = applyGuardrails(
      input({
        proposed: [{ key: 'data', rationale: 'they talked about CRM constantly' }],
        rules: rules({ exclude: new Set(['data']) }),
      })
    );

    expect(plan.topics).toEqual([]);
    expect(plan.excluded.find((e) => e.key === 'data')?.source).toBe('rule');
  });

  it('lets exclude beat include on the same topic', () => {
    // An author's "never" is a line drawn; a second rule they forgot must not cross it.
    const plan = applyGuardrails(
      input({
        rules: rules({ include: new Set(['data']), exclude: new Set(['data']) }),
      })
    );

    expect(plan.topics.map((t) => t.key)).not.toContain('data');
  });
});

describe('applyGuardrails — the fallback', () => {
  it('uses the fallback set only when nothing else was seated', () => {
    const plan = applyGuardrails(
      input({ proposed: [], settings: settings({ fallbackTopicKeys: ['data', 'talent'] }) })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['data', 'talent']);
    expect(plan.topics.every((t) => t.source === 'fallback')).toBe(true);
    expect(plan.source).toBe('fallback');
  });

  it('does NOT use the fallback when a rule already seated something', () => {
    const plan = applyGuardrails(
      input({
        proposed: [],
        rules: { include: new Set(['talent']), exclude: new Set(), reasonByTopic: new Map() },
        settings: settings({ fallbackTopicKeys: ['data'] }),
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['talent']);
  });

  it('produces an always-topics-only interview when the fallback is empty', () => {
    // Thin, but coherent — and strictly better than stranding the respondent.
    const plan = applyGuardrails(
      input({ proposed: [], settings: settings({ fallbackTopicKeys: [] }) })
    );
    expect(plan.topics).toEqual([]);
  });

  it('honours an exclude even inside the fallback set', () => {
    const plan = applyGuardrails(
      input({
        proposed: [],
        rules: { include: new Set(), exclude: new Set(['data']), reasonByTopic: new Map() },
        settings: settings({ fallbackTopicKeys: ['data', 'talent'] }),
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['talent']);
  });
});

describe('applyGuardrails — the blind-spot check', () => {
  it('samples one topic that did NOT make the cut, at light depth', () => {
    const plan = applyGuardrails(
      input({
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        settings: settings({ maxConditionalTopics: 1, includeCheckTopic: true }),
      })
    );

    expect(plan.checkTopicKey).toBeTruthy();
    expect(plan.checkTopicKey).not.toBe('pipeline');
    const check = plan.topics.find((t) => t.key === plan.checkTopicKey);
    expect(check).toMatchObject({ depth: 'light', source: 'check' });
  });

  it('forces light depth even when the topic is authored full', () => {
    // Its job in THIS interview is to sample an area they did not raise, not to score it.
    const plan = applyGuardrails(
      input({
        topics: [
          topic('open', 'opening'),
          topic('pipeline'),
          topic('data', 'conditional', { depth: 'full' }),
        ],
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        settings: settings({ maxConditionalTopics: 1, includeCheckTopic: true }),
      })
    );

    expect(plan.topics.find((t) => t.key === 'data')?.depth).toBe('light');
  });

  it('honours the author’s nominated preference', () => {
    const plan = applyGuardrails(
      input({
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        settings: settings({
          maxConditionalTopics: 1,
          includeCheckTopic: true,
          checkTopicPreference: ['talent'],
        }),
      })
    );

    expect(plan.checkTopicKey).toBe('talent');
  });

  it('adds nothing when every conditional topic was already selected', () => {
    const plan = applyGuardrails(
      input({
        topics: [topic('open', 'opening'), topic('pipeline')],
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        settings: settings({ includeCheckTopic: true }),
      })
    );

    expect(plan.checkTopicKey).toBeNull();
  });

  it('is skipped entirely when the author turned it off', () => {
    const plan = applyGuardrails(
      input({
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        settings: settings({ maxConditionalTopics: 1, includeCheckTopic: false }),
      })
    );

    expect(plan.checkTopicKey).toBeNull();
    expect(plan.topics).toHaveLength(1);
  });

  it('is added ON TOP of the cap — the limit governs what was chosen, not what was sampled', () => {
    const plan = applyGuardrails(
      input({
        proposed: [
          { key: 'pipeline', rationale: 'a' },
          { key: 'forecast', rationale: 'b' },
        ],
        settings: settings({ maxConditionalTopics: 2, includeCheckTopic: true }),
      })
    );

    expect(plan.topics).toHaveLength(3);
    expect(plan.topics.filter((t) => t.source === 'check')).toHaveLength(1);
  });
});

describe('applyGuardrails — the record', () => {
  it('lists every conditional topic that did not make it, with a reason', () => {
    const plan = applyGuardrails(input({ proposed: [{ key: 'pipeline', rationale: 'a' }] }));

    expect(plan.excluded.map((e) => e.key).sort()).toEqual(['data', 'forecast', 'talent']);
    expect(plan.excluded.every((e) => e.rationale.length > 0)).toBe(true);
  });

  it('suppresses the respondent message when announcing is off', () => {
    const plan = applyGuardrails(input({ settings: settings({ announce: false }) }));
    expect(plan.respondentMessage).toBe('');
  });

  it('carries the message through when announcing is on', () => {
    const plan = applyGuardrails(input({ settings: settings({ announce: true }) }));
    expect(plan.respondentMessage).toBe('I want to go deeper on a few areas.');
  });

  it('stamps the schema version so a later shape change can migrate on read', () => {
    expect(applyGuardrails(input()).v).toBe(1);
  });
});

describe('chooseCheckTopic', () => {
  it('is stable — the same unselected set always yields the same topic', () => {
    const selected = new Set(['pipeline']);
    const a = chooseCheckTopic(TOPICS, selected, settings({ includeCheckTopic: true }));
    const b = chooseCheckTopic(TOPICS, selected, settings({ includeCheckTopic: true }));
    expect(a?.key).toBe(b?.key);
  });

  it('skips a preference that was already selected', () => {
    const check = chooseCheckTopic(
      TOPICS,
      new Set(['talent']),
      settings({ includeCheckTopic: true, checkTopicPreference: ['talent', 'data'] })
    );
    expect(check?.key).toBe('data');
  });
});

describe('plannerCandidates', () => {
  it('offers only conditional topics', () => {
    expect(plannerCandidates(TOPICS, noRules()).map((t) => t.key)).toEqual([
      'pipeline',
      'forecast',
      'talent',
      'data',
    ]);
  });

  it('hides a rule-excluded topic from the planner entirely', () => {
    const rules: RuleOutcome = {
      include: new Set(),
      exclude: new Set(['data']),
      reasonByTopic: new Map(),
    };
    expect(plannerCandidates(TOPICS, rules).map((t) => t.key)).not.toContain('data');
  });

  it('KEEPS a rule-included topic visible, so the planner does not double up on the same ground', () => {
    const rules: RuleOutcome = {
      include: new Set(['data']),
      exclude: new Set(),
      reasonByTopic: new Map(),
    };
    expect(plannerCandidates(TOPICS, rules).map((t) => t.key)).toContain('data');
  });
});

/**
 * The fit stage (C7b) — what a count could never do.
 *
 * Costs are handed in rather than derived from questions, exactly as `applyGuardrails` takes them,
 * so each case states its own arithmetic: a topic is "60 seconds", not "eight likerts and a free
 * text I have to add up to know what this test asserts".
 */
describe('applyGuardrails — the time budget', () => {
  /** Every topic the same price at full depth, a tenth of it light — so drops are legible. */
  function costs(over: Record<string, { full: number; light: number }> = {}) {
    const base: Record<string, { full: number; light: number }> = {
      open: { full: 60, light: 60 },
      spine: { full: 40, light: 40 },
      close: { full: 20, light: 20 },
      pipeline: { full: 100, light: 10 },
      forecast: { full: 100, light: 10 },
      talent: { full: 100, light: 10 },
      data: { full: 100, light: 10 },
    };
    return new Map(Object.entries({ ...base, ...over }));
  }

  // The floor is open + spine + close = 120s. Everything below spends against `budget - 120`.
  const FLOOR = 120;

  const allFour = [
    { key: 'pipeline', rationale: 'a' },
    { key: 'forecast', rationale: 'b' },
    { key: 'talent', rationale: 'c' },
    { key: 'data', rationale: 'd' },
  ];

  it('does nothing at all when the version sets no budget', () => {
    // The load-bearing default: an instrument that never opted in must plan exactly as it did.
    const plan = applyGuardrails(
      input({ proposed: allFour, settings: settings({ maxConditionalTopics: 4 }) })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline', 'forecast', 'talent', 'data']);
    expect(plan.budgetSeconds).toBeUndefined();
    expect(plan.estimatedSeconds).toBeUndefined();
  });

  it('drops the lowest-ranked picks until the plan fits', () => {
    // 320s budget − 120s floor = 200s for routing, which pays for two 100s topics and no more.
    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 320, costs: costs() },
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline', 'forecast']);
    expect(plan.estimatedSeconds).toBe(FLOOR + 200);
    expect(plan.budgetSeconds).toBe(320);
  });

  it('takes them back in reverse — the model’s least confident pick goes first', () => {
    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 420, costs: costs() },
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline', 'forecast', 'talent']);
  });

  it('prices topics individually — a cheap fourth topic fits where an expensive one did not', () => {
    // The whole point of seconds over a count: `data` at 20s is not the same decision as `data`
    // at 100s, and a topic limit cannot tell them apart.
    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 440, costs: costs({ data: { full: 20, light: 10 } }) },
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline', 'forecast', 'talent', 'data']);
    expect(plan.estimatedSeconds).toBe(FLOOR + 320);
  });

  it('records a dropped topic as over-budget, NOT as one the agent passed over', () => {
    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 320, costs: costs() },
      })
    );

    const dropped = plan.excluded.filter((e) => e.source === 'budget').map((e) => e.key);
    expect(dropped).toEqual(['talent', 'data']);
    expect(plan.excluded.find((e) => e.key === 'talent')?.rationale).toContain('5m 20s');
  });

  it('never drops a rule-included topic — an author’s “always” outranks the arithmetic', () => {
    const plan = applyGuardrails(
      input({
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        rules: {
          include: new Set(['talent']),
          exclude: new Set(),
          reasonByTopic: new Map([['talent', 'headcount > 500']]),
        },
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 200, costs: costs() },
      })
    );

    // 200s − 120s floor = 80s, less than either topic. The rule survives; the model's pick does not.
    expect(plan.topics.map((t) => t.key)).toEqual(['talent']);
    expect(plan.estimatedSeconds).toBeGreaterThan(200);
  });

  it('fits the fallback too — a safety net is not a licence to run long', () => {
    const plan = applyGuardrails(
      input({
        proposed: [],
        settings: settings({ maxConditionalTopics: 4, fallbackTopicKeys: ['data', 'talent'] }),
        budget: { budgetSeconds: 240, costs: costs() },
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['data']);
    expect(plan.source).toBe('fallback');
  });

  it('reserves the blind-spot check’s seconds rather than treating them as free', () => {
    // 340s − 120s floor = 220s. Two 100s topics fit (200s), but only if the 10s check is ignored —
    // which is exactly the omission the pilot client workbook's own arithmetic makes.
    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4, includeCheckTopic: true }),
        budget: { budgetSeconds: 340, costs: costs({ talent: { full: 100, light: 100 } }) },
      })
    );

    // `talent` is the cheapest-ranked survivor of the fit, but its light sample costs 100s, so the
    // plan can afford only one full topic beside it.
    expect(plan.topics.filter((t) => t.source !== 'check').map((t) => t.key)).toEqual(['pipeline']);
    expect(plan.checkTopicKey).toBe('forecast');
    expect(plan.estimatedSeconds).toBeLessThanOrEqual(340);
  });

  it('counts the check topic in the estimate it records', () => {
    const plan = applyGuardrails(
      input({
        proposed: [{ key: 'pipeline', rationale: 'a' }],
        settings: settings({ maxConditionalTopics: 4, includeCheckTopic: true }),
        budget: { budgetSeconds: 400, costs: costs() },
      })
    );

    // floor 120 + pipeline 100 + the light check 10.
    expect(plan.estimatedSeconds).toBe(230);
  });

  it('seats nothing conditional when the floor alone exceeds the budget', () => {
    // A broken configuration rather than a tight one — and the settings tab says so
    // (`budget_below_floor`). The interview still runs; it just stops adapting.
    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 60, costs: costs() },
      })
    );

    expect(plan.topics).toEqual([]);
    expect(plan.excluded.every((e) => e.source === 'budget')).toBe(true);
  });

  it('charges nothing for a topic it has no price for', () => {
    // An unpriced topic resolves to no members. Charging a guess for it would drop a real topic to
    // make room for an imaginary one.
    const unpriced = costs();
    unpriced.delete('forecast');

    const plan = applyGuardrails(
      input({
        proposed: allFour,
        settings: settings({ maxConditionalTopics: 4 }),
        budget: { budgetSeconds: 320, costs: unpriced },
      })
    );

    expect(plan.topics.map((t) => t.key)).toEqual(['pipeline', 'forecast', 'talent']);
  });
});

describe('applyGuardrails — a proposal that names only part of a topic (C6 / F17.29)', () => {
  const wide = topic('wide', 'conditional', {
    members: { dataSlotKeys: ['wide_ds'], questionKeys: ['wide_q1', 'wide_q2', 'wide_q3'] },
  });
  const topics = [topic('open', 'opening'), wide];

  it('seats the named items, in the instrument’s order', () => {
    const plan = applyGuardrails(
      input({
        topics,
        proposed: [
          {
            key: 'wide',
            rationale: 'two of these',
            members: { questionKeys: ['wide_q3', 'wide_q1'] },
          },
        ],
      })
    );

    expect(plan.topics[0]?.members).toEqual({
      questionKeys: ['wide_q1', 'wide_q3'],
      // Naming questions says nothing about the topic's data slots, so those stay whole.
      dataSlotKeys: ['wide_ds'],
    });
  });

  it('discards a key the topic does not contain', () => {
    const plan = applyGuardrails(
      input({
        topics,
        proposed: [
          {
            key: 'wide',
            rationale: 'x',
            members: { questionKeys: ['wide_q1', 'someone_elses_q'] },
          },
        ],
      })
    );

    expect(plan.topics[0]?.members?.questionKeys).toEqual(['wide_q1']);
  });

  it('leaves the topic whole when nothing named survives — the depth decides again', () => {
    // Same treatment as a planner naming a topic that does not exist: this layer exists to make
    // any input coherent, and routing into nothing is not coherent.
    const plan = applyGuardrails(
      input({
        topics,
        proposed: [{ key: 'wide', rationale: 'x', members: { questionKeys: ['nope'] } }],
      })
    );

    expect(plan.topics[0]?.members).toBeUndefined();
  });

  it('carries no members at all for an ordinary whole-topic pick', () => {
    const plan = applyGuardrails(
      input({ topics, proposed: [{ key: 'wide', rationale: 'all of it' }] })
    );
    expect(plan.topics[0]).not.toHaveProperty('members');
  });

  it('prices the subset, so the fit keeps a topic the whole one would have lost', () => {
    // The point of threading per-item seconds through the budget: charging `full` for a
    // three-of-ten subset drops a topic that fits, and the admin sees a budget that lies.
    const seconds = {
      byQuestionKey: new Map([
        ['open_q', 10],
        ['wide_q1', 10],
        ['wide_q2', 100],
        ['wide_q3', 100],
      ]),
      byDataSlotKey: new Map([['wide_ds', 0]]),
    };
    const costs = new Map([
      ['open', { full: 10, light: 10 }],
      ['wide', { full: 210, light: 110 }],
    ]);

    const shared = {
      topics,
      proposed: [
        { key: 'wide', rationale: 'one of these', members: { questionKeys: ['wide_q1'] } },
      ],
      settings: settings({ includeCheckTopic: false }),
    };

    // Allowance = 60 - 10 (the always-run opening) = 50. The whole topic costs 210; the named item
    // costs 10.
    const priced = applyGuardrails(
      input({ ...shared, budget: { budgetSeconds: 60, costs, seconds, weights: undefined } })
    );
    expect(priced.topics.map((t) => t.key)).toEqual(['wide']);
    expect(priced.estimatedSeconds).toBe(20);

    // Without the per-item prices the subset is charged at its depth — an over-estimate, which
    // drops the topic rather than overrunning the respondent's time.
    const unpriced = applyGuardrails(input({ ...shared, budget: { budgetSeconds: 60, costs } }));
    expect(unpriced.topics).toEqual([]);
  });
});
