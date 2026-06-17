/**
 * Unit test: adaptive data-slot selection (the impure seam behind the `selectDataSlot` invoker).
 *
 * Mocks the embedder, the pgvector ranking, and the selector-agent stream. Asserts the fail-soft
 * guards (no message, <2 candidates, no embeddings, selector error, off-range pick all → null) and
 * the happy path (ranked candidates → an in-pool key + the selector spend), plus that the candidate
 * set keeps a same-theme slot so the topic-local rhythm stays available.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({ embedText: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({ drainStreamChat: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings', () => ({
  rankDataSlotsByVector: vi.fn(),
}));

import {
  buildDataSlotSelectorPrompt,
  selectNextDataSlot,
  type DataSlotSelectionContext,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/data-slot-selection';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { rankDataSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import type { DataSlotTarget } from '@/lib/app/questionnaire/orchestrator';

type Mock = ReturnType<typeof vi.fn>;

function ds(id: string, theme: string): DataSlotTarget {
  return {
    id,
    key: id,
    name: `Name ${id}`,
    description: `Desc ${id}`,
    theme,
    ordinal: 0,
    weight: 1,
  };
}

const UNFILLED = [ds('d1', 'A'), ds('d2', 'A'), ds('d3', 'B'), ds('d4', 'B')];

function ctx(over: Partial<DataSlotSelectionContext> = {}): DataSlotSelectionContext {
  return {
    unfilled: UNFILLED,
    recentMessages: ['I just moved house and it has been stressful'],
    activeTheme: 'A',
    parkedTheme: null,
    sessionId: 's1',
    userId: 'u1',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (embedText as unknown as Mock).mockResolvedValue({
    embedding: [0.1, 0.2],
    model: 'text-embedding-3-small',
    provider: 'openai',
    dimensions: 1536,
    inputTokens: 9,
    costUsd: 0.0000009,
  });
  (rankDataSlotsByVector as unknown as Mock).mockResolvedValue(['d3', 'd2', 'd4']);
  (drainStreamChat as unknown as Mock).mockResolvedValue({
    assistantText: '{"choice": 1, "rationale": "follows naturally"}',
    costUsd: 0.003,
    errorCode: null,
  });
});

describe('selectNextDataSlot — fail-soft guards', () => {
  it('returns null when there is no last message (nothing to rank against)', async () => {
    expect(await selectNextDataSlot(ctx({ recentMessages: [] }))).toBeNull();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('returns null when fewer than 2 candidates remain', async () => {
    expect(await selectNextDataSlot(ctx({ unfilled: [ds('d1', 'A')] }))).toBeNull();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('returns null when the version has no embeddings to rank against', async () => {
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue([]);
    expect(await selectNextDataSlot(ctx())).toBeNull();
  });

  it('returns null on a selector stream error', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue({
      assistantText: '',
      costUsd: 0,
      errorCode: 'provider_error',
    });
    expect(await selectNextDataSlot(ctx())).toBeNull();
  });

  it('returns null when the selector declines (choice 0) or picks out of range', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue({
      assistantText: '{"choice": 0, "rationale": "none fit"}',
      costUsd: 0.001,
      errorCode: null,
    });
    expect(await selectNextDataSlot(ctx())).toBeNull();
  });

  it('returns null on an unparseable selector reply', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue({
      assistantText: 'not json',
      costUsd: 0,
      errorCode: null,
    });
    expect(await selectNextDataSlot(ctx())).toBeNull();
  });

  it('returns null for an anonymous session without embedding or calling the selector', async () => {
    // The selector's streamChat persists an AiConversation keyed to a real user; an anon session's
    // synthetic userId has no user row, so we must never reach it — defer to the deterministic pick.
    expect(await selectNextDataSlot(ctx({ anonymous: true }))).toBeNull();
    expect(embedText).not.toHaveBeenCalled();
    expect(drainStreamChat).not.toHaveBeenCalled();
  });
});

describe('selectNextDataSlot — happy path', () => {
  it('returns the chosen in-pool key + the selector spend', async () => {
    // Candidates = same-theme A (d1, d2) + ranked (d3, d2, d4), deduped → [d1, d2, d3, d4].
    // choice 1 → d1.
    const result = await selectNextDataSlot(ctx());
    expect(result).toEqual({
      dataSlotKey: 'd1',
      rationale: 'follows naturally',
      costUsd: 0.003,
    });
    expect(embedText).toHaveBeenCalledWith('I just moved house and it has been stressful', 'query');
  });

  it('embeds the LAST recent message as the similarity query', async () => {
    await selectNextDataSlot(ctx({ recentMessages: ['older', 'the latest thing they said'] }));
    expect(embedText).toHaveBeenCalledWith('the latest thing they said', 'query');
  });
});

describe('selectNextDataSlot — inspector capture', () => {
  it('records one embedding trace on the ranked path', async () => {
    const recordInspectorCall = vi.fn();
    await selectNextDataSlot(ctx({ recordInspectorCall }));

    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.kind).toBe('embedding');
    expect(trace.label).toBe('Adaptive data-slot ranking');
    expect(trace.dimensions).toBe(1536);
    expect(trace.tokensIn).toBe(9);
    expect(trace.tokensOut).toBeUndefined();
  });

  it('records no trace on the fail-soft paths (no message, un-embedded version)', async () => {
    const recordInspectorCall = vi.fn();
    await selectNextDataSlot(ctx({ recordInspectorCall, recentMessages: [] }));
    (rankDataSlotsByVector as unknown as Mock).mockResolvedValue([]);
    await selectNextDataSlot(ctx({ recordInspectorCall }));

    expect(recordInspectorCall).not.toHaveBeenCalled();
  });

  it('also records the selector LLM pick (cost + tokens + prompt/response)', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue({
      assistantText: '{"choice": 1, "rationale": "follows naturally"}',
      costUsd: 0.003,
      latencyMs: 540,
      tokenUsage: { input: 220, output: 18 },
      errorCode: null,
    });
    const recordInspectorCall = vi.fn();
    await selectNextDataSlot(ctx({ recordInspectorCall }));

    // Two traces this turn: the embedding ranking, then the selector LLM pick.
    const labels = recordInspectorCall.mock.calls.map((c) => c[0].label);
    expect(labels).toEqual(['Adaptive data-slot ranking', 'Data-slot selector']);
    const pick = recordInspectorCall.mock.calls[1][0];
    expect(pick.kind).toBeUndefined(); // an LLM call, not an embedding
    expect(pick.costUsd).toBe(0.003);
    expect(pick.tokensIn).toBe(220);
    expect(pick.tokensOut).toBe(18);
    expect(pick.prompt[0].content).toContain('Candidate topics to explore next');
    expect(pick.response).toContain('"choice": 1');
  });
});

describe('buildDataSlotSelectorPrompt', () => {
  it('lists candidates with theme + description and notes the active theme to linger in', () => {
    const prompt = buildDataSlotSelectorPrompt(ctx({ goal: 'Understand wellbeing' }), [
      ds('d1', 'A'),
      ds('d3', 'B'),
    ]);
    expect(prompt).toContain('Questionnaire goal: Understand wellbeing');
    expect(prompt).toContain('1. Name d1 (theme: A)');
    expect(prompt).toContain('What it captures: Desc d1');
    expect(prompt).toContain('currently exploring the area: "A"');
    expect(prompt).toContain('"choice"');
  });
});
