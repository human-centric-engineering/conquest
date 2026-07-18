/**
 * Report research module — unit tests for the bounded web-search tool loop.
 *
 * Drives `runReportResearch` with a mocked provider + capability dispatcher: rounds are respected,
 * findings come from the real dispatched search results (deduped), a synthesis note is captured, cost
 * is summed across turns, and every failure mode (missing agent, search error, backend down) degrades
 * to an empty result without throwing.
 *
 * @see lib/app/questionnaire/report/research.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { LlmResponse, LlmToolCall } from '@/lib/orchestration/llm/types';
import { logger } from '@/lib/logging';
import { REPORT_MAX_RESEARCH_FINDINGS } from '@/lib/app/questionnaire/report/content';

const findUnique = vi.fn();
const resolveAgentProviderAndModel = vi.fn();
const getProviderWithFallbacks = vi.fn();
const dispatch = vi.fn();
const chat = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: { aiAgent: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
vi.mock('@/lib/logging', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: (...a: unknown[]) => resolveAgentProviderAndModel(...a),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: (...a: unknown[]) => getProviderWithFallbacks(...a),
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: (...a: unknown[]) => dispatch(...a) },
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: () => ({
    inputCostUsd: 0,
    outputCostUsd: 0.01,
    totalCostUsd: 0.01,
    isLocal: false,
  }),
}));

import { runReportResearch } from '@/lib/app/questionnaire/report/research';

const AGENT = {
  id: 'agent-1',
  provider: '',
  model: '',
  fallbackProviders: [],
  systemInstructions: 'You research.',
  temperature: 0.3,
  maxTokens: 2048,
};

function toolCall(id: string, query: string): LlmToolCall {
  return { id, name: 'web_search', arguments: { query } };
}

function response(over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: '',
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'gpt-5.4',
    finishReason: 'stop',
    ...over,
  };
}

function searchOk(results: unknown[]) {
  return { success: true, data: { results } };
}

const baseOpts = {
  phase: 'before' as const,
  instructions: 'Find benchmarks.',
  maxResults: 5,
  context: 'the answers',
  sessionId: 'sess-1',
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so a persistent `chat`/`dispatch` implementation set by one
  // test cannot leak into the next — clearAllMocks only wipes call history, leaving a base
  // mockResolvedValue/mockRejectedValue in place to be silently hit by a later under-mocked call.
  vi.resetAllMocks();
  findUnique.mockResolvedValue(AGENT);
  resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-5.4',
    fallbacks: [],
  });
  getProviderWithFallbacks.mockResolvedValue({
    provider: { chat: (...a: unknown[]) => chat(...a) },
    usedSlug: 'openai',
  });
});

describe('runReportResearch', () => {
  it('returns an empty result (no provider work) when the agent is not seeded', async () => {
    findUnique.mockResolvedValue(null);
    const res = await runReportResearch({ ...baseOpts, rounds: 2 });
    expect(res).toEqual({ findings: [], costUsd: 0, searches: [] });
    expect(resolveAgentProviderAndModel).not.toHaveBeenCalled();
  });

  it('runs the rounds, dedupes real findings, captures a synthesis note, and sums cost', async () => {
    chat
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c1', 'q1')], finishReason: 'tool_use' })
      )
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c2', 'q2')], finishReason: 'tool_use' })
      )
      .mockResolvedValueOnce(response({ content: 'Overall, benchmarks look strong.' }));
    dispatch
      .mockResolvedValueOnce(
        searchOk([
          { title: 'A', url: 'https://a.test', snippet: 'sa' },
          { title: 'Dup', url: 'https://a.test', snippet: 'dupe' }, // same URL → deduped
        ])
      )
      .mockResolvedValueOnce(searchOk([{ title: 'B', url: 'https://b.test', snippet: 'sb' }]));

    const res = await runReportResearch({ ...baseOpts, rounds: 2 });

    expect(res.findings).toEqual([
      { title: 'A', url: 'https://a.test', snippet: 'sa' },
      { title: 'B', url: 'https://b.test', snippet: 'sb' },
    ]);
    expect(res.note).toBe('Overall, benchmarks look strong.');
    // Two search calls + one synthesis call, each costed.
    expect(chat).toHaveBeenCalledTimes(3);
    expect(res.costUsd).toBeCloseTo(0.03);
    // The dispatched count is clamped to maxResults.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ query: 'q1', count: 5 });
  });

  it('forwards only query + count to the search tool, dropping any extra hallucinated args', async () => {
    // The dispatched web_search schema is `.strict()`; an extra key would fail the whole call.
    chat
      .mockResolvedValueOnce(
        response({
          toolCalls: [
            {
              id: 'c1',
              name: 'web_search',
              arguments: { query: 'q1', count: 3, lang: 'en', freshness: 'week' },
            },
          ],
          finishReason: 'tool_use',
        })
      )
      .mockResolvedValueOnce(response({ content: 'Done.' }));
    dispatch.mockResolvedValueOnce(searchOk([{ title: 'A', url: 'https://a.test', snippet: 's' }]));

    await runReportResearch({ ...baseOpts, rounds: 1 });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ query: 'q1', count: 3 });
  });

  it('resolves the provider with the agent’s fallback providers', async () => {
    resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-5.4',
      fallbacks: ['anthropic', 'azure'],
    });
    chat.mockResolvedValueOnce(response({ content: 'Nothing to add.' }));

    await runReportResearch({ ...baseOpts, rounds: 1 });

    expect(getProviderWithFallbacks).toHaveBeenCalledWith('openai', ['anthropic', 'azure']);
  });

  it('stops early when the model returns no tool call (no search performed)', async () => {
    chat.mockResolvedValueOnce(response({ content: 'Nothing to add.' }));
    const res = await runReportResearch({ ...baseOpts, rounds: 3 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(res.findings).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('ends rounds early when the search backend is unavailable', async () => {
    chat.mockResolvedValue(
      response({ toolCalls: [toolCall('c1', 'q1')], finishReason: 'tool_use' })
    );
    dispatch.mockResolvedValue({
      success: false,
      error: { code: 'host_not_allowed', message: 'no' },
    });

    const res = await runReportResearch({ ...baseOpts, rounds: 3 });

    expect(res.findings).toEqual([]);
    // One search attempted, then the loop breaks (backend down) rather than burning all 3 rounds.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('never throws — a provider error yields an empty result with accumulated cost', async () => {
    chat.mockRejectedValue(new Error('provider exploded'));
    const res = await runReportResearch({ ...baseOpts, rounds: 2 });
    expect(res.findings).toEqual([]);
    expect(res.costUsd).toBe(0);
  });

  it('coerces a non-Error rejection via String() instead of crashing on .message', async () => {
    findUnique.mockRejectedValue('boom'); // reject with a plain string, not an Error instance
    const res = await runReportResearch({ ...baseOpts, rounds: 2 });
    expect(res).toEqual({ findings: [], costUsd: 0, searches: [] });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'report research: failed; continuing without research',
      expect.objectContaining({ error: 'boom' })
    );
  });

  it('uses the after-phase framing and drafted-report language in the prompt', async () => {
    chat.mockResolvedValueOnce(response({ content: 'Enriched with sources.' }));

    const res = await runReportResearch({
      ...baseOpts,
      phase: 'after',
      rounds: 2,
      context: 'draft report text',
    });

    expect(dispatch).not.toHaveBeenCalled();
    const [messages] = chat.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0]?.content).toContain('already been drafted');
    expect(messages[1]?.content).toContain('The drafted report');
    expect(res.note).toBe('Enriched with sources.');
  });

  it('omits persona and task lines from the system prompt when neither is configured', async () => {
    findUnique.mockResolvedValue({ ...AGENT, systemInstructions: '  ' });
    chat.mockResolvedValueOnce(response({ content: 'No search needed.' }));

    await runReportResearch({ ...baseOpts, instructions: '   ', rounds: 1 });

    const [messages] = chat.mock.calls[0] as [Array<{ content: string }>];
    const systemContent = messages[0]?.content ?? '';
    expect(systemContent).not.toContain('You research.');
    expect(systemContent).not.toContain('Your task from the report author');
    expect(systemContent).toContain('gathering external web context');
  });

  it('falls back to the default max-tokens and tolerates a non-string synthesis reply', async () => {
    findUnique.mockResolvedValue({ ...AGENT, maxTokens: 0 });
    chat
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c1', 'q1')], finishReason: 'tool_use' })
      )
      .mockResolvedValueOnce(response({ content: undefined }));
    dispatch.mockResolvedValueOnce(
      searchOk([{ title: 'C', url: 'https://c.test', snippet: 'sc' }])
    );

    const res = await runReportResearch({ ...baseOpts, rounds: 1 });

    // agent.maxTokens is falsy (0) — both the search-round call and the synthesis call should
    // fall back to the module's own default rather than passing 0 through to the provider.
    for (const call of chat.mock.calls) {
      expect(call[1]).toMatchObject({ maxTokens: 1500 });
    }
    // A non-string synthesis reply degrades to no note at all, not a crash.
    expect(res).not.toHaveProperty('note');
    expect(res.findings).toEqual([{ title: 'C', url: 'https://c.test', snippet: 'sc' }]);
    expect(res.costUsd).toBeCloseTo(0.02);
  });

  it('returns an empty note (not a thrown error) when the synthesis turn itself fails', async () => {
    chat
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c1', 'q1')], finishReason: 'tool_use' })
      )
      .mockRejectedValueOnce(new Error('synthesis timed out'));
    dispatch.mockResolvedValueOnce(
      searchOk([{ title: 'D', url: 'https://d.test', snippet: 'sd' }])
    );

    const res = await runReportResearch({ ...baseOpts, rounds: 1 });

    expect(res.findings).toEqual([{ title: 'D', url: 'https://d.test', snippet: 'sd' }]);
    expect(res).not.toHaveProperty('note');
    // The failed synthesis call contributes no cost of its own.
    expect(res.costUsd).toBeCloseTo(0.01);
  });

  it('marks a second tool call in the same turn as budget-exhausted once rounds are used up', async () => {
    chat
      .mockResolvedValueOnce(
        response({
          toolCalls: [toolCall('c1', 'q1'), toolCall('c2', 'q2')],
          finishReason: 'tool_use',
        })
      )
      // The budget-exhausted turn has findings but no closing text, so a synthesis call follows —
      // mock it explicitly rather than letting it fall through to another mock's leftover behaviour.
      .mockResolvedValueOnce(response({ content: 'Synthesis over the one dispatched source.' }));
    dispatch.mockResolvedValueOnce(
      searchOk([{ title: 'E', url: 'https://e.test', snippet: 'se' }])
    );

    const res = await runReportResearch({ ...baseOpts, rounds: 1 });

    // Only the first call in the turn is dispatched; the second is short-circuited by the
    // already-exhausted round budget rather than spending a second search.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(res.findings).toEqual([{ title: 'E', url: 'https://e.test', snippet: 'se' }]);
    expect(res.note).toBe('Synthesis over the one dispatched source.');
  });

  it('rejects a tool call for anything other than web_search, then continues the loop', async () => {
    chat
      .mockResolvedValueOnce(
        response({
          toolCalls: [{ id: 'c1', name: 'not_web_search', arguments: {} }],
          finishReason: 'tool_use',
        })
      )
      .mockResolvedValueOnce(response({ content: 'Nothing further to search.' }));

    const res = await runReportResearch({ ...baseOpts, rounds: 2 });

    expect(dispatch).not.toHaveBeenCalled();
    expect(res.findings).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('continues past a non-backend-unavailable search failure and carries through an optional source', async () => {
    chat
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c1', 'q1')], finishReason: 'tool_use' })
      )
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c2', 'q2')], finishReason: 'tool_use' })
      )
      .mockResolvedValueOnce(response({ content: 'Done searching.' }));
    dispatch
      .mockResolvedValueOnce({ success: false }) // no error object at all — no message, no code
      .mockResolvedValueOnce(
        searchOk([{ title: 'F', url: 'https://f.test', snippet: 'sf', source: 'Reuters' }])
      );

    const res = await runReportResearch({ ...baseOpts, rounds: 2 });

    // The failed round didn't trip the backend-unavailable early exit — round 2 still ran.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(res.findings).toEqual([
      { title: 'F', url: 'https://f.test', snippet: 'sf', source: 'Reuters' },
    ]);
    expect(res.note).toBe('Done searching.');
  });

  it('clamps a numeric requested count to the per-round and global caps', async () => {
    chat
      .mockResolvedValueOnce(
        response({
          toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'q1', count: 100 } }],
          finishReason: 'tool_use',
        })
      )
      .mockResolvedValueOnce(
        response({
          toolCalls: [{ id: 'c2', name: 'web_search', arguments: { query: 'q2', count: 0 } }],
          finishReason: 'tool_use',
        })
      );
    dispatch.mockResolvedValue(searchOk([]));

    await runReportResearch({ ...baseOpts, rounds: 2, maxResults: 5 });

    // Over-requesting clamps down to maxResults (5) — MAX_REPORT_RESEARCH_RESULTS (10) is looser.
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ count: 5 });
    // A non-positive request floors to 1 rather than clamping to 0.
    expect(dispatch.mock.calls[1]?.[1]).toMatchObject({ count: 1 });
  });

  it('caps deduped findings at REPORT_MAX_RESEARCH_FINDINGS even when more unique results return', async () => {
    const many = Array.from({ length: REPORT_MAX_RESEARCH_FINDINGS + 5 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://result-${i}.test`,
      snippet: `snippet ${i}`,
    }));
    chat
      .mockResolvedValueOnce(
        response({ toolCalls: [toolCall('c1', 'q1')], finishReason: 'tool_use' })
      )
      .mockResolvedValueOnce(response({ content: 'Plenty of coverage found.' }));
    dispatch.mockResolvedValueOnce(searchOk(many));

    const res = await runReportResearch({ ...baseOpts, rounds: 1 });

    expect(res.findings).toHaveLength(REPORT_MAX_RESEARCH_FINDINGS);
    expect(res.findings[0]).toMatchObject({ title: 'Result 0', url: 'https://result-0.test' });
  });
});
