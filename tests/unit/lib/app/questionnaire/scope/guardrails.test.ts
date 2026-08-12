import { describe, it, expect } from 'vitest';

import {
  applyGuardrails,
  chooseCheckTopic,
  plannerCandidates,
  type ApplyGuardrailsInput,
} from '@/lib/app/questionnaire/scope/guardrails';
import type { RuleOutcome } from '@/lib/app/questionnaire/scope/rules';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
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

function settings(over: Partial<AdaptiveScopeSettings> = {}): AdaptiveScopeSettings {
  return {
    ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
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
