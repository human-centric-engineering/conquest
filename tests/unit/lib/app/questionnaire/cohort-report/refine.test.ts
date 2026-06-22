/**
 * Unit test: per-section AI-assist (F14.5).
 *
 * Mocks the agent/provider and asserts `refineCohortReportSection` passes the section + instruction to
 * the model and returns the parsed heading + HTML body, and throws when the agent isn't seeded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { refineCohortReportSection } from '@/lib/app/questionnaire/cohort-report/refine';

type Mock = ReturnType<typeof vi.fn>;

function fakeProvider(json: object) {
  const chat = vi.fn().mockResolvedValue({
    content: JSON.stringify(json),
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'test-model',
    finishReason: 'stop',
  });
  return { provider: { chat }, chat };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    provider: 'openai',
    model: 'm',
    fallbackProviders: [],
    systemInstructions: 'analyst',
    temperature: 0.3,
    maxTokens: 4096,
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({ providerSlug: 'openai', model: 'm' });
});

describe('refineCohortReportSection', () => {
  it('returns the revised heading + body and forwards the instruction', async () => {
    const { provider, chat } = fakeProvider({
      heading: 'Tighter heading',
      body: '<p>Shorter.</p>',
    });
    (getProvider as Mock).mockResolvedValue(provider);

    const out = await refineCohortReportSection({
      heading: 'Engagement',
      body: '<p>Long original body.</p>',
      instruction: 'make it shorter',
    });

    expect(out).toEqual({ heading: 'Tighter heading', body: '<p>Shorter.</p>' });
    const user = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user'
    );
    expect(user?.content).toContain('make it shorter');
    expect(user?.content).toContain('Engagement');
  });

  it('throws when the cohort-report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(
      refineCohortReportSection({ heading: 'H', body: 'B', instruction: 'x' })
    ).rejects.toThrow(/not seeded/);
  });
});
