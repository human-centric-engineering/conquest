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
});
