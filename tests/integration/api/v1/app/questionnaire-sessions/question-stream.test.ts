/**
 * Integration test: the streaming conversational question phraser.
 *
 * The agent lookup, provider resolution, provider stream, and cost tracker are mocked. Pins
 * the streamed prose (content frames + returned message + cost), the fail-soft fallback to the
 * VERBATIM prompt (no agent, no provider, mid-stream error before any text), the option/scale
 * extraction, and the prompt assembly (acknowledge / re-ask / opening + audience calibration).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '@/types/orchestration';

const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const resolverMock = vi.hoisted(() => ({ resolveAgentProviderAndModel: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => resolverMock);

const providerMgrMock = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/provider-manager', () => providerMgrMock);

const costMock = vi.hoisted(() => ({
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.0007 })),
  logCost: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => costMock);

import {
  buildStreamingQuestionPrompt,
  extractOptionLabels,
  streamQuestionMessage,
  type QuestionComposeInput,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';

type Mock = ReturnType<typeof vi.fn>;

const PROMPT = 'How easy was it to set up your account during onboarding?';

const INPUT: QuestionComposeInput = {
  prompt: PROMPT,
  type: 'free_text',
  recentMessages: [],
  lastUserMessage: 'it was a nightmare',
  isReask: false,
  isOpening: false,
  questionsAsked: 4,
};

/** Drain the generator into its yielded content deltas + its return value. */
async function drain(
  gen: AsyncGenerator<ChatEvent, { message: string; costUsd: number }, undefined>
): Promise<{ deltas: string[]; ret: { message: string; costUsd: number } }> {
  const deltas: string[] = [];
  let next = await gen.next();
  while (!next.done) {
    if (next.value.type === 'content') deltas.push(next.value.delta);
    next = await gen.next();
  }
  return { deltas, ret: next.value };
}

/** A provider whose chatStream yields the given text chunks then a done usage. */
function streamingProvider(chunks: string[]) {
  return {
    chatStream: async function* () {
      for (const content of chunks) yield { type: 'text', content };
      yield { type: 'done', usage: { inputTokens: 40, outputTokens: 15 }, finishReason: 'stop' };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-int',
    provider: 'openai',
    model: 'gpt',
    fallbackProviders: [],
  });
  resolverMock.resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-x',
    fallbacks: [],
  });
});

describe('streamQuestionMessage — success', () => {
  it('streams conversational prose and returns the accumulated message + cost', async () => {
    providerMgrMock.getProvider.mockResolvedValue(
      streamingProvider(['Sorry to hear that — ', 'how easy was setup, ', 'roughly?'])
    );

    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );

    expect(deltas).toEqual(['Sorry to hear that — ', 'how easy was setup, ', 'roughly?']);
    expect(ret.message).toBe('Sorry to hear that — how easy was setup, roughly?');
    expect(ret.costUsd).toBe(0.0007);
    expect(costMock.calculateCost).toHaveBeenCalledWith('gpt-x', 40, 15);
    expect(costMock.logCost).toHaveBeenCalledTimes(1);
  });
});

describe('streamQuestionMessage — fail-soft to the verbatim prompt', () => {
  it('falls back to the verbatim prompt when the interviewer agent is unconfigured', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([PROMPT]);
    expect(ret).toEqual({ message: PROMPT, costUsd: 0 });
    expect(providerMgrMock.getProvider).not.toHaveBeenCalled();
  });

  it('falls back to the verbatim prompt when no provider resolves', async () => {
    (resolverMock.resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([PROMPT]);
    expect(ret.message).toBe(PROMPT);
  });

  it('falls back to the verbatim prompt when the stream throws before any text', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        throw new Error('stream boom');

        yield { type: 'text', content: 'x' };
      },
    });
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([PROMPT]);
    expect(ret.costUsd).toBe(0);
  });

  it('keeps the partial phrasing when the stream throws after some text arrived', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        yield { type: 'text', content: 'Got it — ' };
        throw new Error('mid-stream boom');
      },
    });
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual(['Got it — ']);
    expect(ret.message).toBe('Got it — ');
    expect(ret.costUsd).toBe(0);
  });

  it('uses the verbatim prompt when the stream completes empty', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        // yields nothing and never errors — empty completion
      },
    });
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([]);
    expect(ret).toEqual({ message: PROMPT, costUsd: 0 });
  });

  it('still returns the message when cost logging rejects (fire-and-forget)', async () => {
    providerMgrMock.getProvider.mockResolvedValue(streamingProvider(['How did setup go?']));
    (costMock.logCost as Mock).mockRejectedValue(new Error('cost write failed'));
    const { ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(ret.message).toBe('How did setup go?');
    expect(ret.costUsd).toBe(0.0007);
  });
});

describe('extractOptionLabels', () => {
  it('pulls a string array from `options`', () => {
    expect(extractOptionLabels({ options: ['easy', 'okay', 'difficult'] })).toEqual([
      'easy',
      'okay',
      'difficult',
    ]);
  });

  it('pulls `label` fields from an array of objects (scale)', () => {
    expect(
      extractOptionLabels({
        scale: [
          { label: 'Low', value: 1 },
          { label: 'High', value: 5 },
        ],
      })
    ).toEqual(['Low', 'High']);
  });

  it('returns undefined for missing / non-array / empty config', () => {
    expect(extractOptionLabels(null)).toBeUndefined();
    expect(extractOptionLabels({})).toBeUndefined();
    expect(extractOptionLabels({ options: [] })).toBeUndefined();
    expect(extractOptionLabels('nope')).toBeUndefined();
  });
});

describe('buildStreamingQuestionPrompt', () => {
  const text = (content: string | unknown[]): string => {
    if (typeof content !== 'string') throw new Error('expected string content');
    return content;
  };

  it('instructs to acknowledge the prior answer on a normal turn and includes the prompt + last message', () => {
    const messages = buildStreamingQuestionPrompt(INPUT);
    expect(messages).toHaveLength(2);
    const system = text(messages[0].content);
    expect(system).toMatch(/acknowledge what they just said/i);
    expect(system).toMatch(/no JSON/i);
    const user = text(messages[1].content);
    expect(user).toContain(PROMPT);
    expect(user).toContain('it was a nightmare');
  });

  it('switches to opening framing (no acknowledgement) when isOpening', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, isOpening: true })[0].content);
    expect(system).toMatch(/first question/i);
    expect(system).not.toMatch(/acknowledge what they just said/i);
  });

  it('switches to re-ask framing when isReask', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, isReask: true })[0].content);
    expect(system).toMatch(/could not capture a usable answer|re-ask/i);
  });

  it('offers the scale choices naturally when typeConfig has options', () => {
    const user = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        type: 'likert',
        typeConfig: { options: ['easy', 'okay', 'difficult'] },
      })[1].content
    );
    expect(user).toContain('easy, okay, difficult');
  });

  it('calibrates tone to a novice audience and a non-English locale', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        audience: { expertiseLevel: 'novice', locale: 'fr' },
      })[0].content
    );
    expect(system).toMatch(/plain language/i);
    expect(system).toMatch(/locale "fr"/i);
  });

  it('does not force a language switch for an English locale', () => {
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, audience: { locale: 'en-GB' } })[0].content
    );
    expect(system).not.toMatch(/Respond entirely/i);
  });

  it('always instructs to ask one thing at a time and not bundle sub-questions', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).toMatch(/ONE thing at a time/i);
    expect(system).toMatch(/do not bundle/i);
  });

  it('keeps early questions VERY tight (first few of the session)', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 0 })[0].content);
    expect(system).toMatch(/very short and tight/i);
    expect(system).not.toMatch(/rapport has built/i);
  });

  it('relaxes length once rapport has built (later in the session)', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 6 })[0].content);
    expect(system).toMatch(/concise/i);
    expect(system).toMatch(/rapport has built/i);
    expect(system).not.toMatch(/very short and tight/i);
  });

  it('prods for nuance on a normal deepen turn instead of bundling more questions', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).toMatch(/brief or surface-level/i);
    expect(system).toMatch(/one light follow-up/i);
  });

  it('does not add the nuance prod on an opening or transition turn', () => {
    const opening = text(buildStreamingQuestionPrompt({ ...INPUT, isOpening: true })[0].content);
    const transition = text(
      buildStreamingQuestionPrompt({ ...INPUT, isTransition: true })[0].content
    );
    expect(opening).not.toMatch(/brief or surface-level/i);
    expect(transition).not.toMatch(/brief or surface-level/i);
  });

  it('adds a tread-carefully block (with the latest note) when a sensitivity level is set', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        sensitivityLevel: 'high',
        sensitivityNotes: ['Reports mistreatment by a senior colleague.'],
      })[0].content
    );
    expect(system).toMatch(/sensitive or difficult/i);
    expect(system).toContain('Reports mistreatment by a senior colleague.');
  });

  it('omits the tread-carefully block when no sensitivity level is set', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).not.toMatch(/sensitive or difficult/i);
  });
});
