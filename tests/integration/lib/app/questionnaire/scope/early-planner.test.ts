/**
 * Integration test: the early-seating judgement's failure paths and its prompt.
 *
 * The sibling of `planner.test.ts`, and it asks the same question of a module with a stricter
 * answer. `planScope` must always produce a usable plan; `judgeEarlySeating` must always produce a
 * usable ABSENCE of one. Every way the model call can go wrong has to resolve to no judgements,
 * because the trigger writes the session record either way and the final planner still runs — a
 * throw here would 500 a turn over an optional improvement.
 *
 * The prompt is asserted too, and not as a string snapshot. Three of its instructions are the
 * feature's safety argument rather than its wording: the per-turn cap the caller passed, the
 * respondent-facing reason being addressed to the respondent, and the ban on saying how the
 * interview decides. A prompt that quietly stopped carrying those would still return well-formed
 * JSON, so nothing else in the suite would notice.
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

import { judgeEarlySeating } from '@/lib/app/questionnaire/scope/early-planner';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';

type Mock = ReturnType<typeof vi.fn>;

function topic(key: string, over: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase: 'conditional',
    criteria: 'when it fits',
    depth: 'full',
    members: { dataSlotKeys: [`${key}_ds`], questionKeys: [`${key}_q`] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
    ...over,
  };
}

const CANDIDATES = [topic('hiring'), topic('capacity')];

function settings(over: Partial<ConditionalTopicsSettings> = {}): ConditionalTopicsSettings {
  return {
    ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
    enabled: true,
    earlyTopicSeating: true,
    ...over,
  };
}

function params(over: Partial<Parameters<typeof judgeEarlySeating>[0]> = {}) {
  return {
    sessionId: 'sess-1',
    candidates: CANDIDATES,
    fills: [{ key: 'open_ds', value: null, paraphrase: 'The team has doubled this year.' }],
    answers: [],
    goal: null,
    settings: settings(),
    coveragePct: 60,
    maxThisTurn: 1,
    ...over,
  };
}

/** A well-formed model reply. */
function completion(value: unknown, costUsd = 0.001) {
  return { value, costUsd, tokenUsage: { input: 400, output: 60 } };
}

/** One judgement in the shape the schema accepts. */
function judgement(over: Record<string, unknown> = {}) {
  return {
    topicKey: 'hiring',
    confidence: 0.92,
    rationale: 'They said the team has doubled this year.',
    respondentReason: "You mentioned the team has doubled, so we'll spend a little time on hiring.",
    ...over,
  };
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

describe('judgeEarlySeating — the happy path', () => {
  it('returns the model’s judgements with the audit snapshot filled in', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [judgement()] }));

    const result = await judgeEarlySeating(params());

    expect(result.judgements).toEqual([
      {
        key: 'hiring',
        confidence: 0.92,
        rationale: 'They said the team has doubled this year.',
        respondentReason:
          "You mentioned the team has doubled, so we'll spend a little time on hiring.",
      },
    ]);
    expect(result.costUsd).toBeGreaterThan(0);
    // "Why did this respondent get that area, four turns before the plan existed" has to be
    // answerable months later, and the trigger only records a run when a prompt came back.
    expect(result.promptSnapshot).toContain('hiring');
    expect(result.outputSnapshot).toEqual({ clear: [judgement()] });
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.4');
  });

  it('treats an empty list as a complete answer, not a failure', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [] }));

    const result = await judgeEarlySeating(params());

    // Naming nothing is the normal outcome, so it must still look like a pass that ran: the
    // snapshot is what stamps the evidence key and stops the next turn paying for the same
    // question over the same evidence.
    expect(result.judgements).toEqual([]);
    expect(result.promptSnapshot).not.toBeNull();
  });

  it('clamps a confidence the model put out of range', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(
      completion({
        clear: [
          judgement({ confidence: 1.4 }),
          judgement({ topicKey: 'capacity', confidence: -3 }),
        ],
      })
    );

    const result = await judgeEarlySeating(params());

    // Everything downstream compares this against the author's bar. Unclamped, 1.4 clears any bar
    // there is, which would make the bar decorative.
    expect(result.judgements.map((j) => j.confidence)).toEqual([1, 0]);
  });

  it('logs the cost against the planner agent without letting a logging failure surface', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [] }));
    mocks.logCost.mockRejectedValueOnce(new Error('cost table down'));

    const result = await judgeEarlySeating(params());

    expect(mocks.logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        model: 'gpt-5.4',
        provider: 'openai',
        metadata: expect.objectContaining({
          capability: 'app_early_topic_seating',
          sessionId: 'sess-1',
        }),
      })
    );
    // The judgement is the product; the cost row is bookkeeping. Losing the second must never cost
    // the first.
    expect(result.judgements).toEqual([]);
  });
});

describe('judgeEarlySeating — the prompt carries the feature’s safety argument', () => {
  async function promptFor(over: Partial<Parameters<typeof judgeEarlySeating>[0]> = {}) {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [] }));
    const result = await judgeEarlySeating(params(over));
    return result.promptSnapshot ?? '';
  }

  it('states the per-turn cap the caller passed, so it cannot invite a list nothing can take', async () => {
    expect(await promptFor({ maxThisTurn: 1 })).toContain('AT MOST 1 area');
    expect(await promptFor({ maxThisTurn: 3 })).toContain('AT MOST 3 areas');
  });

  it('says how much of the opening is in, rather than implying it is all of it', async () => {
    const prompt = await promptFor({ coveragePct: 42 });

    expect(prompt).toContain('42%');
    expect(prompt).toContain('not all of it');
  });

  it('says plainly that naming nothing is correct', async () => {
    // Without this the model reaches for an area to look useful, which is precisely the
    // thin-evidence seat the confidence bar exists to prevent.
    expect(await promptFor()).toContain('NAMING NOTHING IS THE NORMAL AND CORRECT ANSWER');
  });

  it('forbids reasoning from what the respondent has not said yet', async () => {
    expect(await promptFor()).toContain('will probably say it later');
  });

  it('bans the respondent-facing reason from explaining how the interview decides', async () => {
    const prompt = await promptFor();

    // The vocabulary ban is what makes giving the respondent a reason safe at all: they may be
    // told what will now be covered and why, and nothing about the machinery that chose it.
    expect(prompt).toContain('nothing about how the interview decides');
    expect(prompt).toContain('No jargon, no keys, no scores');
  });

  it('carries the administrator’s own guidance and the questionnaire goal when set', async () => {
    const prompt = await promptFor({
      goal: 'Understand why deals stall.',
      settings: settings({ plannerInstructions: 'Never assume company size.' }),
    });

    expect(prompt).toContain('Understand why deals stall.');
    expect(prompt).toContain('Never assume company size.');
  });

  it('omits the goal and the guidance sections entirely when neither is set', async () => {
    const prompt = await promptFor({ goal: null, settings: settings({ plannerInstructions: '' }) });

    expect(prompt).not.toContain('questionnaire_goal');
    expect(prompt).not.toContain('additional_guidance_from_the_administrator');
  });
});

describe('judgeEarlySeating — every way the call can fail', () => {
  it('judges nothing when no planner agent is configured', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue(null);

    const result = await judgeEarlySeating(params());

    expect(result).toEqual({
      judgements: [],
      costUsd: 0,
      provider: null,
      model: null,
      promptSnapshot: null,
      outputSnapshot: null,
    });
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('judges nothing when the agent lookup itself throws', async () => {
    mocks.prisma.aiAgent.findUnique.mockRejectedValue(new Error('db down'));

    const result = await judgeEarlySeating(params());

    expect(result.judgements).toEqual([]);
    expect(result.promptSnapshot).toBeNull();
  });

  it('judges nothing when no provider resolves', async () => {
    mocks.resolveAgentProviderAndModel.mockRejectedValue(new Error('no provider'));

    const result = await judgeEarlySeating(params());

    expect(result.judgements).toEqual([]);
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('judges nothing when the provider cannot be loaded', async () => {
    mocks.getProvider.mockRejectedValue(new Error('provider missing'));

    const result = await judgeEarlySeating(params());

    expect(result.judgements).toEqual([]);
    expect(result.costUsd).toBe(0);
  });

  it('judges nothing when the call throws — timeout, provider down, bad JSON after retry', async () => {
    (mocks.runStructuredCompletion as Mock).mockRejectedValue(new Error('timed out'));

    const result = await judgeEarlySeating(params());

    // The whole contract: the session is left exactly as it was, and the interview decides at the
    // end of the opening the way it always did.
    expect(result).toEqual({
      judgements: [],
      costUsd: 0,
      provider: null,
      model: null,
      promptSnapshot: null,
      outputSnapshot: null,
    });
  });

  it('survives a rejection that is not an Error, which is what a raw SDK throw looks like', async () => {
    // Every failure path formats the reason with `err instanceof Error ? err.message : String(err)`.
    // A provider client rejecting with a bare string is the case that arm exists for, and getting
    // it wrong turns a fail-soft skip into a throw inside the catch.
    mocks.prisma.aiAgent.findUnique.mockRejectedValue('db down');
    expect((await judgeEarlySeating(params())).judgements).toEqual([]);

    mocks.prisma.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: '',
      model: '',
      fallbackProviders: [],
    });
    mocks.resolveAgentProviderAndModel.mockRejectedValue('no provider');
    expect((await judgeEarlySeating(params())).judgements).toEqual([]);

    mocks.resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-5.4',
    });
    (mocks.runStructuredCompletion as Mock).mockRejectedValue('timed out');
    expect((await judgeEarlySeating(params())).judgements).toEqual([]);

    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [] }));
    mocks.logCost.mockRejectedValueOnce('cost table down');
    expect((await judgeEarlySeating(params())).judgements).toEqual([]);
  });

  it('reports a missing cost as zero rather than as undefined', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue({
      value: { clear: [] },
      tokenUsage: { input: 1, output: 1 },
    });

    const result = await judgeEarlySeating(params());

    expect(result.costUsd).toBe(0);
  });
});

describe('judgeEarlySeating — the JSON contract handed to the completion helper', () => {
  /**
   * What the module actually handed the completion helper.
   *
   * Read from the recorded call rather than captured by a `mockImplementation`, because an
   * implementation that returns the completion is a promise-returning callback in a `void` slot —
   * the shape `no-misused-promises` exists to stop.
   */
  function callArgs(): {
    parse: (raw: string) => unknown;
    onFinalFailure: () => Error;
    retryUserMessage: string;
  } {
    return (mocks.runStructuredCompletion as Mock).mock.calls[0][0];
  }

  it('rejects a reply that is not the early-seating shape', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [] }));

    await judgeEarlySeating(params());

    const { parse } = callArgs();
    expect(parse).toBeDefined();
    // The parser is the only thing between a model's prose and a topic key, so it has to refuse
    // everything that is not the exact shape rather than coerce it.
    expect(parse?.('not json at all')).toBeNull();
    expect(parse?.('{"selected":[]}')).toBeNull();
    expect(parse?.('{"clear":[{"topicKey":"hiring"}]}')).toBeNull();
    expect(parse?.('{"clear":[]}')).toEqual({ clear: [] });
    expect(parse?.(JSON.stringify({ clear: [judgement()] }))).toEqual({
      clear: [judgement()],
    });
  });

  it('gives up with an error after the one retry rather than resolving to something invented', async () => {
    (mocks.runStructuredCompletion as Mock).mockResolvedValue(completion({ clear: [] }));

    await judgeEarlySeating(params());

    const { onFinalFailure, retryUserMessage } = callArgs();

    // The helper throws whatever this returns, and the outer catch turns it into a skip. Returning
    // anything but an Error would put a non-Error through the `instanceof` arm above.
    expect(onFinalFailure?.()).toBeInstanceOf(Error);
    // The retry has to restate the shape, or the second attempt is the first attempt again.
    expect(retryUserMessage).toContain('"clear"');
  });
});
