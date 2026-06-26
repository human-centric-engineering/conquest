/**
 * Unit test for the streaming Config Advisor orchestrator (`stream-advisor.ts`).
 *
 * Drives the async generator with a mocked provider whose `chatStream` emits the narrative in chunks
 * and whose `chat` (via the real `runStructuredCompletion`) returns the structured analysis. Asserts
 * the event lifecycle (`narrative_delta`* → `narrative_done` → `analysis`), the fatal paths (no
 * provider, provider unavailable, empty narrative, analysis never validates) — each a single `error`
 * and never a throw — and that cost is logged exactly once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.001, isLocal: false })),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { streamAdvisor } = await import('@/lib/app/questionnaire/advisor/stream-advisor');
import type { AdvisorGenEvent } from '@/lib/app/questionnaire/advisor/advisor-events';
import type { AdvisorContext } from '@/lib/app/questionnaire/advisor/context';
import type { StreamChunk } from '@/lib/orchestration/llm/types';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

type Mock = ReturnType<typeof vi.fn>;

const ANALYSIS = JSON.stringify({
  conflicts: [{ title: 'C', detail: 'd', settings: ['accessMode'], severity: 'warning' }],
  suggestions: [
    { id: 's1', title: 'T', rationale: 'r', severity: 'info', patch: { voiceEnabled: true } },
  ],
});

const context: AdvisorContext = {
  questionnaire: { title: 'Q', status: 'draft', demoClientName: null },
  version: { versionNumber: 1, status: 'draft', goal: 'g', audience: null, sessionCount: 0 },
  structure: {
    sectionCount: 1,
    questionCount: 2,
    requiredCount: 1,
    optionalCount: 1,
    typeHistogram: { free_text: 2 },
    sections: [{ title: 'S', questionCount: 2, samplePrompts: ['p1', 'p2'] }],
  },
  config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true },
  dataSlots: { count: 0, samples: [] },
  scoring: { present: false, name: null },
};

const agent = { provider: '', model: '', fallbackProviders: [] };

/** Build a provider whose chatStream emits `chunks` then a done, and whose chat returns `analysis`. */
function makeProvider(opts: { chunks?: string[]; analysis?: string } = {}) {
  const chunks = opts.chunks ?? ['Hello ', 'world.'];
  const analysis = opts.analysis ?? ANALYSIS;
  return {
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      for (const c of chunks) yield { type: 'text', content: c };
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 8 }, finishReason: 'stop' };
    }),
    chat: vi.fn(async () => ({
      content: analysis,
      usage: { inputTokens: 7, outputTokens: 6 },
      model: 'm',
      finishReason: 'stop' as const,
    })),
  };
}

async function collect(gen: AsyncGenerator<AdvisorGenEvent>) {
  const events: AdvisorGenEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('streamAdvisor', () => {
  it('streams narrative deltas, then narrative_done, then analysis', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider({ chunks: ['A', 'B', 'C'] }));

    const events = await collect(streamAdvisor({ context, agent }));

    const deltas = events.filter((e) => e.type === 'narrative_delta');
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual(['A', 'B', 'C']);

    // Ordering: all deltas precede narrative_done, which precedes analysis.
    const doneIdx = events.findIndex((e) => e.type === 'narrative_done');
    const analysisIdx = events.findIndex((e) => e.type === 'analysis');
    expect(doneIdx).toBeGreaterThan(0);
    expect(analysisIdx).toBeGreaterThan(doneIdx);

    const analysis = events.find((e) => e.type === 'analysis');
    expect(analysis).toMatchObject({
      conflicts: [{ title: 'C', severity: 'warning' }],
      suggestions: [{ id: 's1', patch: { voiceEnabled: true } }],
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('logs cost exactly once for the run', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider());

    await collect(streamAdvisor({ context, agent, agentId: 'agent-1' }));

    expect(logCost).toHaveBeenCalledTimes(1);
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', metadata: { capability: 'advisor' } })
    );
  });

  it('emits no_provider_configured and never calls the provider when resolution fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce(new Error('no provider'));

    const events = await collect(streamAdvisor({ context, agent }));

    expect(events).toEqual([
      { type: 'error', code: 'no_provider_configured', message: expect.any(String) },
    ]);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('emits provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValueOnce(new Error('down'));

    const events = await collect(streamAdvisor({ context, agent }));

    expect(events).toEqual([
      { type: 'error', code: 'provider_unavailable', message: expect.any(String) },
    ]);
  });

  it('emits narrative_failed when the narrative stream throws', async () => {
    (getProvider as Mock).mockResolvedValue({
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text', content: 'partial' };
        throw new Error('stream broke');
      }),
      chat: vi.fn(),
    });

    const events = await collect(streamAdvisor({ context, agent }));

    expect(events.some((e) => e.type === 'error' && e.code === 'narrative_failed')).toBe(true);
    expect(events.some((e) => e.type === 'analysis')).toBe(false);
  });

  it('emits narrative_empty when the stream yields no text', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider({ chunks: [] }));

    const events = await collect(streamAdvisor({ context, agent }));

    expect(events.some((e) => e.type === 'error' && e.code === 'narrative_empty')).toBe(true);
  });

  it('emits analysis_failed (after the narrative streamed) when the analysis never validates', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider({ analysis: 'not json at all' }));

    const events = await collect(streamAdvisor({ context, agent }));

    // The narrative still streamed and settled.
    expect(events.some((e) => e.type === 'narrative_delta')).toBe(true);
    expect(events.some((e) => e.type === 'narrative_done')).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.code === 'analysis_failed')).toBe(true);
    expect(events.some((e) => e.type === 'analysis')).toBe(false);
  });

  it('does not throw when logCost rejects', async () => {
    (logCost as Mock).mockRejectedValueOnce(new Error('cost down'));
    (getProvider as Mock).mockResolvedValue(makeProvider());

    const events = await collect(streamAdvisor({ context, agent }));

    expect(events.some((e) => e.type === 'analysis')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
