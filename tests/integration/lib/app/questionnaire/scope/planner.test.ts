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
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
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
    trigger: null,
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

function settings(over: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return {
    ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
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
});

/**
 * What the planner is allowed to read.
 *
 * The judgement used to see only data-slot fills — extractions from what the respondent said, never
 * the words themselves. An instrument whose opening asks questions without data slots behind them
 * therefore produced no evidence at all, and the planner chose sections from an empty prompt.
 */
describe('planScope — the evidence in the prompt', () => {
  function systemPrompt(): string {
    const call = (mocks.runStructuredCompletion as Mock).mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    return call.messages[0].content;
  }

  it("puts the respondent's own words in the prompt, with the question they answered", async () => {
    await planScope(
      params({
        answers: [
          {
            key: 'q_situation',
            prompt: 'What is getting in the way right now?',
            value: null,
            paraphrase: 'Deals stall the moment procurement gets involved.',
          },
        ],
      })
    );

    const prompt = systemPrompt();
    expect(prompt).toContain('What is getting in the way right now?');
    expect(prompt).toContain('Deals stall the moment procurement gets involved.');
    expect(prompt).toContain('In their own words');
  });

  it('prefers the paraphrase over the mapped form value', async () => {
    // `value` holds the form code for a typed question. Feeding `gt3` to a model reading for
    // meaning is noise; the paraphrase is the account the respondent would recognise.
    await planScope(
      params({
        answers: [
          {
            key: 'q_tenure',
            prompt: 'How long has this been going on?',
            value: 'gt3',
            paraphrase: 'A bit over three years, since the reorg.',
          },
        ],
      })
    );

    const prompt = systemPrompt();
    expect(prompt).toContain('A bit over three years, since the reorg.');
    expect(prompt).not.toContain('gt3');
  });

  it('falls back to the value when a typed answer has no paraphrase', async () => {
    await planScope(
      params({
        answers: [
          { key: 'q_score', prompt: 'How confident are you?', value: 4, paraphrase: null },
          { key: 'q_blank', prompt: 'Anything else?', value: null, paraphrase: null },
        ],
      })
    );

    const prompt = systemPrompt();
    expect(prompt).toContain('How confident are you?');
    expect(prompt).toContain('Answered: 4');
    // Nothing to say is not evidence — the question is dropped rather than printed empty.
    expect(prompt).not.toContain('Anything else?');
  });

  it('keeps the fills too, labelled as extractions rather than separate evidence', async () => {
    await planScope(
      params({
        fills: [{ key: 'open_ds', value: null, paraphrase: 'Procurement is the blocker.' }],
        answers: [
          {
            key: 'q_situation',
            prompt: 'What is getting in the way?',
            value: null,
            paraphrase: 'Deals stall at procurement.',
          },
        ],
      })
    );

    const prompt = systemPrompt();
    expect(prompt).toContain('Captured from what they said');
    expect(prompt).toContain('[open_ds]');
    // The rule that stops the model double-counting an extraction as corroboration.
    expect(prompt).toContain('primary evidence');
  });

  it('caps how many answers it inlines', async () => {
    const answers = Array.from({ length: 40 }, (_, i) => ({
      key: `q${i}`,
      prompt: `Question number ${i}?`,
      value: null,
      paraphrase: `Answer number ${i}.`,
    }));

    await planScope(params({ answers }));

    const prompt = systemPrompt();
    expect(prompt).toContain('Question number 0?');
    expect(prompt).not.toContain('Question number 39?');
  });

  it('still says so plainly when there is nothing at all', async () => {
    await planScope(params({ fills: [], answers: [] }));
    expect(systemPrompt()).toContain('(nothing was captured in the opening)');
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

describe('planScope — naming part of a topic (C6 / F17.29)', () => {
  const WIDE = topic('wide', 'conditional', {
    members: { dataSlotKeys: [], questionKeys: ['wq1', 'wq2', 'wq3'] },
  });
  const PROMPTS = new Map([
    ['wq1', 'How long does approval take?'],
    ['wq2', 'Who signs off above £50k?'],
    ['wq3', 'What did the last escalation cost?'],
  ]);

  function systemPrompt(): string {
    const call = mocks.runStructuredCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    return call.messages[0].content;
  }

  it('lists a candidate’s questions only when the caller supplied their wording', async () => {
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );

    await planScope(params({ topics: [topic('open', 'opening'), WIDE] }));
    expect(systemPrompt()).not.toContain('wq1');

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
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );

    await planScope(params({ topics: [topic('open', 'opening'), WIDE], itemPrompts: PROMPTS }));
    const prompt = systemPrompt();
    expect(prompt).toContain('wq1: How long does approval take?');
    expect(prompt).toContain('wq3: What did the last escalation cost?');
  });

  it('seats the subset the model named', async () => {
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({
        selected: [
          { topicKey: 'wide', rationale: 'only the approval half', questionKeys: ['wq2'] },
        ],
        confidence: 0.9,
        respondentMessage: 'Let us look at approvals.',
      })
    );

    const result = await planScope(
      params({ topics: [topic('open', 'opening'), WIDE], itemPrompts: PROMPTS })
    );

    expect(result.plan.topics[0]?.members).toEqual({
      questionKeys: ['wq2'],
      dataSlotKeys: [],
    });
  });

  it('ignores a subset for a topic whose items it was never shown', async () => {
    // The prompt tells the model a topic with unlisted questions is whole-or-nothing. If it names
    // keys anyway they are keys it invented, and they must not narrow a real interview.
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({
        selected: [{ topicKey: 'wide', rationale: 'guessing', questionKeys: ['q_i_made_up'] }],
        confidence: 0.9,
        respondentMessage: '',
      })
    );

    const result = await planScope(params({ topics: [topic('open', 'opening'), WIDE] }));

    expect(result.plan.topics.map((t) => t.key)).toEqual(['wide']);
    expect(result.plan.topics[0]).not.toHaveProperty('members');
  });

  it('says so rather than truncating when a topic has more questions than it can list', async () => {
    const huge = topic('huge', 'conditional', {
      members: {
        dataSlotKeys: [],
        questionKeys: Array.from({ length: 40 }, (_, i) => `hq${i}`),
      },
    });
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );

    await planScope(
      params({
        topics: [topic('open', 'opening'), huge],
        itemPrompts: new Map(huge.members.questionKeys.map((k) => [k, `asks ${k}`])),
      })
    );

    const prompt = systemPrompt();
    expect(prompt).toContain('choose this topic whole or not at all');
    // Silently listing the first twelve would invite a subset chosen from an arbitrary window.
    expect(prompt).not.toContain('hq0: asks hq0');
  });
});

describe('planScope — rendering a stored answer value', () => {
  beforeEach(() => {
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );
  });

  /** The system prompt the planner actually sent. */
  function systemPromptOf(): string {
    return (mocks.runStructuredCompletion as Mock).mock.calls[0][0].messages[0].content as string;
  }

  function answer(value: unknown, paraphrase: string | null = null) {
    return { key: 'q1', prompt: 'Which regions?', value, paraphrase };
  }

  it('joins a multi-select answer rather than printing "[object Object]"', async () => {
    // A checkbox question stores an ARRAY of mapped slugs. Rendered naively it reaches the model as
    // `[object Object]` or `emea,apac` with no spacing — evidence the planner then reads as noise.
    await planScope(params({ answers: [answer(['emea', 'apac', 'latam'])] }));

    expect(systemPromptOf()).toContain('emea, apac, latam');
  });

  it('drops an empty multi-select instead of printing an empty answer', async () => {
    // "Asked: … Answered:" with nothing after it reads to the model as a refusal to answer, which
    // is a claim about the respondent that an unanswered question does not support.
    await planScope(params({ answers: [answer([])] }));

    expect(systemPromptOf()).not.toContain('Which regions?');
  });

  it('prints a numeric and a boolean answer, including the falsy ones', async () => {
    // `0` and `false` are answers. A truthiness check here would silently drop both.
    await planScope(
      params({
        answers: [
          { key: 'q1', prompt: 'How many reps?', value: 0, paraphrase: null },
          { key: 'q2', prompt: 'Using a CRM?', value: false, paraphrase: null },
        ],
      })
    );

    const prompt = systemPromptOf();
    expect(prompt).toContain('Answered: 0');
    expect(prompt).toContain('Answered: false');
  });

  it('drops an answer with nothing worth printing at all', async () => {
    await planScope(params({ answers: [answer(null), answer('   '), answer(undefined)] }));

    expect(systemPromptOf()).not.toContain('Which regions?');
  });
});

describe('planScope — the structured-completion contract', () => {
  /** The options object the planner handed `runStructuredCompletion`. */
  function callOpts() {
    return (mocks.runStructuredCompletion as Mock).mock.calls[0][0];
  }

  beforeEach(() => {
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({ selected: [], confidence: 0.9, respondentMessage: '' })
    );
  });

  it('parses a well-formed reply into the planner schema', async () => {
    await planScope(params());

    const parsed = callOpts().parse(
      JSON.stringify({
        selected: [
          { topicKey: 'pipeline', rationale: 'deals stalling', respondentReason: 'you said so' },
        ],
        confidence: 0.8,
        respondentMessage: 'Going deeper on pipeline.',
      })
    );

    expect(parsed).toMatchObject({ confidence: 0.8 });
    expect(parsed.selected[0].topicKey).toBe('pipeline');
  });

  it('returns null for a reply that is not the planner shape, so the retry fires', async () => {
    await planScope(params());
    const parse = callOpts().parse;

    // Valid JSON, wrong shape — the schema is what decides, not the JSON parser.
    expect(parse(JSON.stringify({ selected: 'pipeline' }))).toBeNull();
    // Not JSON at all.
    expect(parse('I think we should cover pipeline.')).toBeNull();
  });

  it('names the exact shape it wants in the retry, and fails rather than inventing a plan', async () => {
    await planScope(params());
    const opts = callOpts();

    // A retry message that merely says "try again" gets the same malformed reply back.
    expect(opts.retryUserMessage).toContain('selected');
    expect(opts.retryUserMessage).toContain('confidence');
    // The failure is an Error, not an empty plan: an empty plan would be indistinguishable from the
    // model deliberately choosing nothing, and would be recorded as `llm` rather than a fallback.
    expect(opts.onFinalFailure()).toBeInstanceOf(Error);
  });

  it('still returns the plan when cost logging rejects', async () => {
    // Cost logging is best-effort and runs un-awaited. A rejection must not take the plan with it,
    // and must not surface as an unhandled rejection either.
    mocks.logCost.mockRejectedValueOnce(new Error('cost table gone'));
    mocks.runStructuredCompletion.mockResolvedValue(
      completion({
        selected: [{ topicKey: 'pipeline', rationale: 'deals stalling' }],
        confidence: 0.9,
        respondentMessage: 'ok',
      })
    );

    const result = await planScope(params());

    expect(result.plan.topics.map((t) => t.key)).toEqual(['pipeline']);
    expect(result.plan.source).toBe('llm');
    // Let the un-awaited `.catch` settle so a regression to a bare `void logCost(...)` surfaces here
    // as an unhandled rejection rather than in an unrelated test.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
