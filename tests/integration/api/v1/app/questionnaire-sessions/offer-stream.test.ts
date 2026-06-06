/**
 * Integration test: the streaming completion-offer composer (F6.1, PR5).
 *
 * The agent lookup, provider resolution, provider stream, and cost tracker are mocked. Pins
 * the streamed prose (content frames + returned message + cost) and the fail-soft fallbacks
 * (no agent, no provider, mid-stream error before any text).
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
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.0009 })),
  logCost: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => costMock);

import {
  buildStreamingOfferPrompt,
  FALLBACK_OFFER_MESSAGE,
  streamOfferMessage,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/offer-stream';

type Mock = ReturnType<typeof vi.fn>;

const INPUT = {
  coverage: 1,
  answeredCount: 2,
  capReached: false,
  coveredSlots: [{ key: 'role', prompt: 'Role?' }],
  remainingSlots: [],
  recentMessages: [],
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
      yield { type: 'done', usage: { inputTokens: 30, outputTokens: 12 }, finishReason: 'stop' };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-1',
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

describe('streamOfferMessage — success', () => {
  it('streams prose deltas and returns the accumulated message + cost', async () => {
    providerMgrMock.getProvider.mockResolvedValue(
      streamingProvider(['Nice ', 'work — ', 'submit?'])
    );

    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );

    expect(deltas).toEqual(['Nice ', 'work — ', 'submit?']);
    expect(ret.message).toBe('Nice work — submit?');
    expect(ret.costUsd).toBe(0.0009);
    expect(costMock.calculateCost).toHaveBeenCalledWith('gpt-x', 30, 12);
    expect(costMock.logCost).toHaveBeenCalledTimes(1);
  });
});

describe('streamOfferMessage — fail-soft', () => {
  it('falls back to a single frame when the completion agent is unconfigured', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([FALLBACK_OFFER_MESSAGE]);
    expect(ret).toEqual({ message: FALLBACK_OFFER_MESSAGE, costUsd: 0 });
    expect(providerMgrMock.getProvider).not.toHaveBeenCalled();
  });

  it('falls back when no provider resolves', async () => {
    (resolverMock.resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([FALLBACK_OFFER_MESSAGE]);
    expect(ret.message).toBe(FALLBACK_OFFER_MESSAGE);
  });

  it('falls back when the stream throws before any text', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        throw new Error('stream boom');

        yield { type: 'text', content: 'x' };
      },
    });
    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([FALLBACK_OFFER_MESSAGE]);
    expect(ret.costUsd).toBe(0);
  });

  it('keeps the partial text when the stream throws after some text arrived', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        yield { type: 'text', content: 'Partial ' };
        throw new Error('mid-stream boom');
      },
    });
    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    // The already-streamed text is kept (no fallback frame appended); cost is 0 (no usage).
    expect(deltas).toEqual(['Partial ']);
    expect(ret.message).toBe('Partial ');
    expect(ret.costUsd).toBe(0);
  });

  it('returns 0 cost when the stream yields text but no done usage', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        yield { type: 'text', content: 'Looks done.' };
        // no `done` chunk → no usage captured
      },
    });
    const { ret } = await drain(streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' }));
    expect(ret.message).toBe('Looks done.');
    expect(ret.costUsd).toBe(0);
    expect(costMock.logCost).not.toHaveBeenCalled();
  });

  it('still returns the message when cost logging rejects (fire-and-forget)', async () => {
    providerMgrMock.getProvider.mockResolvedValue(streamingProvider(['Done.']));
    (costMock.logCost as Mock).mockRejectedValue(new Error('cost write failed'));
    const { ret } = await drain(streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' }));
    expect(ret.message).toBe('Done.');
    expect(ret.costUsd).toBe(0.0009);
  });

  it('handles a non-Error thrown from the stream (string reason)', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        // Deliberately a non-Error to exercise the `String(err)` defensive branch.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'boom-string';

        yield { type: 'text', content: 'x' };
      },
    });
    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([FALLBACK_OFFER_MESSAGE]);
    expect(ret.message).toBe(FALLBACK_OFFER_MESSAGE);
  });

  it('silently returns the fallback message (no content frame) when the stream completes empty', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        // yields nothing and never errors — empty completion
      },
    });
    const { deltas, ret } = await drain(
      streamOfferMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([]);
    expect(ret).toEqual({ message: FALLBACK_OFFER_MESSAGE, costUsd: 0 });
  });
});

describe('buildStreamingOfferPrompt', () => {
  /** The prompt builder always emits string content; narrow it for the assertions. */
  const text = (content: string | unknown[]): string => {
    if (typeof content !== 'string') throw new Error('expected string content');
    return content;
  };

  it('builds a plain-prose system + user prompt with covered + remaining + cap', () => {
    const messages = buildStreamingOfferPrompt({
      coverage: 0.8,
      answeredCount: 4,
      capReached: true,
      coveredSlots: [{ key: 'role', prompt: 'Role?' }],
      remainingSlots: [{ key: 'team', prompt: 'Team?' }],
      recentMessages: [],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(text(messages[0].content)).toMatch(/no JSON/i);
    const user = text(messages[1].content);
    expect(user).toContain('80%');
    expect(user).toContain('limit was reached');
    expect(user).toContain('Role?');
    expect(user).toContain('Team?');
  });

  it('omits the optional + cap sections when nothing remains and the cap was not hit', () => {
    const user = text(
      buildStreamingOfferPrompt({
        coverage: 1,
        answeredCount: 2,
        capReached: false,
        coveredSlots: [{ key: 'role', prompt: 'Role?' }],
        remainingSlots: [],
        recentMessages: [],
      })[1].content
    );
    expect(user).not.toContain('Still optional');
    expect(user).not.toContain('limit was reached');
  });

  it('falls back to a placeholder when nothing has been covered yet', () => {
    const user = text(
      buildStreamingOfferPrompt({
        coverage: 0,
        answeredCount: 0,
        capReached: false,
        coveredSlots: [],
        remainingSlots: [],
        recentMessages: [],
      })[1].content
    );
    expect(user).toContain('(nothing yet)');
  });
});
