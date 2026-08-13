/**
 * Integration test: the Scope Planner's failure paths.
 *
 * The planner runs mid-conversation with a respondent waiting, so the property that matters most is
 * not "does it choose well" — it is **does it always produce a usable plan**. Every case below is a
 * way the model call can go wrong; every one must still resolve to a plan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
  resolveAgentProviderAndModel: vi.fn(),
  getProvider: vi.fn(),
  runStructuredCompletion: vi.fn(),
  logCost: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: mocks.resolveAgentProviderAndModel,
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: mocks.getProvider }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: mocks.runStructuredCompletion,
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: mocks.logCost }));

import { isOpeningComplete, planScope } from '@/lib/app/questionnaire/scope/planner';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
  type Topic,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';

type Mock = ReturnType<typeof vi.fn>;

function topic(key: string, phase: TopicPhase = 'conditional', over: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: 'when it fits',
    depth: 'full',
    members: { dataSlotKeys: [`${key}_ds`], questionKeys: [`${key}_q`] },
    ordinal: 0,
    source: 'seeded',
    ...over,
  };
}

const TOPICS = [
  topic('open', 'opening'),
  topic('pipeline'),
  topic('forecast'),
  topic('talent'),
  topic('close', 'closing'),
];

function settings(over: Partial<AdaptiveScopeSettings> = {}): AdaptiveScopeSettings {
  return {
    ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
    enabled: true,
    maxConditionalTopics: 2,
    includeCheckTopic: false,
    ...over,
  };
}

function params(over: Partial<Parameters<typeof planScope>[0]> = {}) {
  return {
    sessionId: 'sess-1',
    topics: TOPICS,
    fills: [{ key: 'open_ds', value: null, paraphrase: 'Deals keep stalling at procurement.' }],
    settings: settings(),
    decidedAtTurn: 4,
    ...over,
  };
}

/** A well-formed model reply. */
function completion(value: unknown, costUsd = 0.002) {
  return { value, costUsd, tokenUsage: { input: 500, output: 80 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-1',
    provider: '',
    model: '',
    fallbackProviders: [],
  });
  mocks.resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-5.4',
  });
  mocks.getProvider.mockResolvedValue({});
});

describe('planScope — the happy path', () => {
  it('seats the model’s picks and carries its message to the respondent', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({
        selected: [{ topicKey: 'pipeline', rationale: 'deals stalling' }],
        confidence: 0.88,
        respondentMessage: 'I want to go deeper on your pipeline.',
      })
    );

    const result = await planScope(params());

    expect(result.plan.topics.map((t) => t.key)).toEqual(['pipeline']);
    expect(result.plan.respondentMessage).toBe('I want to go deeper on your pipeline.');
    expect(result.plan.confidence).toBeCloseTo(0.88);
    expect(result.plan.source).toBe('llm');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('records the prompt and the model output for the audit snapshot', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );

    const result = await planScope(params());

    // "Why did this respondent get those topics" must be answerable months later.
    expect(result.promptSnapshot).toContain('pipeline');
    expect(result.outputSnapshot).toBeTruthy();
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.4');
  });
});

describe('planScope — every way the model call can fail', () => {
  const fallback = settings({ fallbackTopicKeys: ['talent'] });

  it('falls back when no planner agent is configured', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue(null);

    const result = await planScope(params({ settings: fallback }));

    expect(result.plan.topics.map((t) => t.key)).toEqual(['talent']);
    expect(result.plan.source).toBe('fallback');
    expect(result.costUsd).toBe(0);
  });

  it('falls back when no provider resolves', async () => {
    mocks.resolveAgentProviderAndModel.mockRejectedValue(new Error('no provider'));

    const result = await planScope(params({ settings: fallback }));

    expect(result.plan.source).toBe('fallback');
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('falls back when the call throws (timeout, provider down, unparseable after retry)', async () => {
    (mocks.runStructuredCompletion as Mock).mockRejectedValue(new Error('timed out'));

    const result = await planScope(params({ settings: fallback }));

    expect(result.plan.topics.map((t) => t.key)).toEqual(['talent']);
    expect(result.plan.source).toBe('fallback');
  });

  it('falls back when confidence is below the floor, and says nothing to the respondent', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({
        selected: [{ topicKey: 'pipeline', rationale: 'maybe' }],
        confidence: 0.2,
        respondentMessage: 'I want to go deeper on your pipeline.',
      })
    );

    const result = await planScope(
      params({ settings: settings({ minConfidence: 0.6, fallbackTopicKeys: ['talent'] }) })
    );

    expect(result.plan.topics.map((t) => t.key)).toEqual(['talent']);
    // The model's sentence described topics the fallback did not choose — saying it would be a lie.
    expect(result.plan.respondentMessage).toBe('');
  });

  it('drops a hallucinated topic key rather than routing into nothing', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({
        selected: [
          { topicKey: 'not_a_real_topic', rationale: 'invented' },
          { topicKey: 'forecast', rationale: 'real' },
        ],
        confidence: 0.9,
        respondentMessage: 'ok',
      })
    );

    const result = await planScope(params());

    expect(result.plan.topics.map((t) => t.key)).toEqual(['forecast']);
  });

  it('clamps an out-of-range confidence rather than discarding a good plan', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({
        selected: [{ topicKey: 'pipeline', rationale: 'a' }],
        confidence: 1.4,
        respondentMessage: 'ok',
      })
    );

    const result = await planScope(params());

    expect(result.plan.confidence).toBe(1);
    expect(result.plan.topics.map((t) => t.key)).toEqual(['pipeline']);
  });

  it('produces an always-topics-only interview when the model fails AND no fallback is set', async () => {
    (mocks.runStructuredCompletion as Mock).mockRejectedValue(new Error('down'));

    const result = await planScope(params({ settings: settings({ fallbackTopicKeys: [] }) }));

    // Thin, but coherent — and strictly better than stranding someone mid-conversation.
    expect(result.plan.topics).toEqual([]);
    expect(result.plan.v).toBe(1);
  });

  it('never throws — even when the agent lookup itself fails', async () => {
    // A database blip is no more the respondent's problem than a model timeout is.
    mocks.prisma.aiAgent.findUnique.mockRejectedValue(new Error('db down'));

    const result = await planScope(params({ settings: fallback }));

    expect(result.plan.topics.map((t) => t.key)).toEqual(['talent']);
    expect(result.plan.source).toBe('fallback');
  });
});

describe('planScope — skipping the call', () => {
  it('does not call the model when there are no conditional topics', async () => {
    const result = await planScope(
      params({ topics: [topic('open', 'opening'), topic('close', 'closing')] })
    );

    // Paying for a foregone conclusion is waste, and the latency lands on someone waiting.
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
    expect(result.costUsd).toBe(0);
    expect(result.plan.topics).toEqual([]);
  });

  it('does not call the model when every candidate is rule-excluded', async () => {
    const result = await planScope(
      params({
        settings: settings({
          rules: [
            {
              id: 'r1',
              dataSlotKey: 'open_ds',
              operator: 'exists',
              value: null,
              action: 'exclude',
              topicKey: 'pipeline',
              ordinal: 0,
            },
            {
              id: 'r2',
              dataSlotKey: 'open_ds',
              operator: 'exists',
              value: null,
              action: 'exclude',
              topicKey: 'forecast',
              ordinal: 1,
            },
            {
              id: 'r3',
              dataSlotKey: 'open_ds',
              operator: 'exists',
              value: null,
              action: 'exclude',
              topicKey: 'talent',
              ordinal: 2,
            },
          ],
        }),
      })
    );

    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
    expect(result.plan.topics).toEqual([]);
  });
});

describe('planScope — hard rules reach the prompt correctly', () => {
  it('hides a rule-excluded topic from the candidate list the model sees', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );

    await planScope(
      params({
        settings: settings({
          rules: [
            {
              id: 'r1',
              dataSlotKey: 'open_ds',
              operator: 'contains',
              value: 'procurement',
              action: 'exclude',
              topicKey: 'talent',
              ordinal: 0,
            },
          ],
        }),
      })
    );

    const call = (mocks.runStructuredCompletion as Mock).mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    const system = call.messages[0].content;
    expect(system).toContain('pipeline');
    expect(system).not.toContain('key: talent');
  });

  it('tells the model the limit it is choosing under', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );

    await planScope(params({ settings: settings({ maxConditionalTopics: 3 }) }));

    const call = (mocks.runStructuredCompletion as Mock).mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0].content).toContain('AT MOST 3');
  });
});

describe('isOpeningComplete', () => {
  it('is false until every opening data slot is filled', () => {
    const topics = [
      topic('open', 'opening', {
        members: { dataSlotKeys: ['situation', 'goals'], questionKeys: [] },
      }),
    ];

    expect(isOpeningComplete(topics, new Set(['situation']))).toBe(false);
    expect(isOpeningComplete(topics, new Set(['situation', 'goals']))).toBe(true);
  });

  it('is true when the version has no opening topic at all', () => {
    expect(isOpeningComplete([topic('pipeline')], new Set())).toBe(true);
  });

  it('is false until every opening QUESTION is answered too', () => {
    // The gate that was missing. An opening built only from questions read as complete before it
    // had been asked, so the planner decided on turn one with nothing captured — and every
    // `not_exists` hard rule matched, because absence is what a veto tests for.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: [], questionKeys: ['q1', 'q2'] } }),
    ];
    const known = new Set(['q1', 'q2']);

    expect(isOpeningComplete(topics, new Set(), { answered: new Set(), known })).toBe(false);
    expect(isOpeningComplete(topics, new Set(), { answered: new Set(['q1']), known })).toBe(false);
    expect(isOpeningComplete(topics, new Set(), { answered: new Set(['q1', 'q2']), known })).toBe(
      true
    );
  });

  it('requires both halves — a filled slot does not excuse an unanswered question', () => {
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: ['situation'], questionKeys: ['q1'] } }),
    ];
    const known = new Set(['q1']);

    expect(isOpeningComplete(topics, new Set(['situation']), { answered: new Set(), known })).toBe(
      false
    );
    expect(isOpeningComplete(topics, new Set(), { answered: new Set(['q1']), known })).toBe(false);
    expect(
      isOpeningComplete(topics, new Set(['situation']), { answered: new Set(['q1']), known })
    ).toBe(true);
  });

  it('ignores an opening member whose question no longer exists', () => {
    // A stale member key can never be answered. Unresolvable keys are skipped everywhere else in
    // this feature; skipping them here is what stops one from holding every interview in its
    // opening forever.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: [], questionKeys: ['q1', 'deleted'] } }),
    ];

    expect(
      isOpeningComplete(topics, new Set(), { answered: new Set(['q1']), known: new Set(['q1']) })
    ).toBe(true);
  });

  it('falls back to the data-slot gate when the caller has no answer data', () => {
    // Optional on purpose: a caller without answers gets the half it can judge rather than nothing.
    const topics = [
      topic('open', 'opening', { members: { dataSlotKeys: [], questionKeys: ['q1'] } }),
    ];
    expect(isOpeningComplete(topics, new Set())).toBe(true);
  });
});
