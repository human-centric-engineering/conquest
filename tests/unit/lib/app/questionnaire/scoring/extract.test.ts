/**
 * Unit test: scoring schema extraction (F14.4, the upload path).
 *
 * Mocks the version's slots/data-slots + agent/provider and asserts `extractScoringSchema` returns a
 * schema scoped to the version's real keys — pruning any proposed item whose `ref` isn't an available
 * question/data-slot key — and throws when the agent isn't seeded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionSlot: { findMany: vi.fn() },
    appDataSlot: { findMany: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { extractScoringSchema } from '@/lib/app/questionnaire/scoring/extract';

type Mock = ReturnType<typeof vi.fn>;

function fakeProvider(json: object) {
  const chat = vi.fn().mockResolvedValue({
    content: JSON.stringify(json),
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'm',
    finishReason: 'stop',
  });
  return { provider: { chat }, chat };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.appQuestionSlot.findMany as Mock).mockResolvedValue([
    { key: 'q1', prompt: 'P1', type: 'likert' },
    { key: 'q2', prompt: 'P2', type: 'likert' },
  ]);
  (prisma.appDataSlot.findMany as Mock).mockResolvedValue([{ key: 'risk', name: 'Risk' }]);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    provider: 'openai',
    model: 'm',
    fallbackProviders: [],
    temperature: 0.3,
    maxTokens: 4096,
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({ providerSlug: 'openai', model: 'm' });
});

describe('extractScoringSchema', () => {
  it('keeps items referencing real keys and prunes the rest', async () => {
    const { provider } = fakeProvider({
      method: 'mean',
      scales: [{ key: 'open', name: 'Openness' }],
      items: [
        { source: 'question', ref: 'q1', scaleKey: 'open', weight: 1, reverse: false },
        { source: 'question', ref: 'ghost', scaleKey: 'open', weight: 1, reverse: false }, // unknown question
        { source: 'dataSlot', ref: 'risk', scaleKey: 'open', weight: 1, reverse: true },
        { source: 'dataSlot', ref: 'nope', scaleKey: 'open', weight: 1, reverse: false }, // unknown data slot
      ],
      bands: [{ scaleKey: 'open', min: 1, max: 5, label: 'All' }],
    });
    (getProvider as Mock).mockResolvedValue(provider);

    const schema = await extractScoringSchema('v1', 'scoring spec text');

    expect(schema.scales).toHaveLength(1);
    expect(schema.items.map((i) => i.ref).sort()).toEqual(['q1', 'risk']);
  });

  it('throws when the cohort-report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(extractScoringSchema('v1', 'text')).rejects.toThrow(/not seeded/);
  });
});
