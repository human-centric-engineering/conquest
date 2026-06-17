/**
 * Unit test: adaptive-strategy dependency wiring (F4.1 / PR3).
 *
 * Mocks the embedder, `drainStreamChat`, and the pgvector rank so the prompt
 * builder, the selector-output parser, and the `llmPick` → candidate-resolution
 * logic (incl. every fail-soft branch) are tested without real I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({ embedText: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({ drainStreamChat: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  rankSlotsByVector: vi.fn(),
}));

import {
  buildAdaptiveDeps,
  buildSelectorPrompt,
  parseSelectorOutput,
} from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { rankSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';

type Mock = ReturnType<typeof vi.fn>;

const candidates = [
  { id: 'q1-id', key: 'q1', prompt: 'What is your name?' },
  { id: 'q2-id', key: 'q2', prompt: 'Describe your goals.' },
];

function drainResult(over: Partial<{ assistantText: string; costUsd: number; errorCode: string }>) {
  return {
    assistantText: '',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 0, output: 0 },
    costUsd: 0,
    latencyMs: 1,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('parseSelectorOutput', () => {
  it('parses a clean JSON envelope', () => {
    expect(parseSelectorOutput('{"choice": 2, "rationale": "flows"}')).toEqual({
      choice: 2,
      rationale: 'flows',
    });
  });

  it('parses a code-fenced JSON envelope', () => {
    expect(parseSelectorOutput('```json\n{"choice":1,"rationale":"x"}\n```')).toEqual({
      choice: 1,
      rationale: 'x',
    });
  });

  it('defaults a missing rationale to empty string', () => {
    expect(parseSelectorOutput('{"choice": 0}')).toEqual({ choice: 0, rationale: '' });
  });

  it('truncates a fractional choice to an integer', () => {
    expect(parseSelectorOutput('{"choice": 2.9, "rationale": "y"}')?.choice).toBe(2);
  });

  it('returns null when choice is missing or non-numeric', () => {
    expect(parseSelectorOutput('{"rationale": "x"}')).toBeNull();
    expect(parseSelectorOutput('{"choice": "two"}')).toBeNull();
    expect(parseSelectorOutput('not json')).toBeNull();
  });
});

describe('buildSelectorPrompt', () => {
  it('numbers the candidates and includes the transcript + JSON instruction', () => {
    const prompt = buildSelectorPrompt({
      recentMessages: ['I just moved house'],
      candidates,
      sessionId: 's1',
    });
    expect(prompt).toContain('1. What is your name?');
    expect(prompt).toContain('2. Describe your goals.');
    expect(prompt).toContain('I just moved house');
    expect(prompt).toMatch(/"choice"/);
  });

  it('falls back to the key when a candidate has no prompt', () => {
    const prompt = buildSelectorPrompt({
      recentMessages: [],
      candidates: [{ id: 'x', key: 'only-key' }],
      sessionId: 's1',
    });
    expect(prompt).toContain('1. only-key');
    expect(prompt).toContain('(no prior messages)');
  });

  it('renders the goal, already-answered set, and per-candidate guidelines/rationale', () => {
    const prompt = buildSelectorPrompt({
      goal: 'Understand onboarding friction',
      recentMessages: ['docs were confusing'],
      answeredQuestions: ['How did you hear about us?'],
      candidates: [
        { id: 'q1', key: 'blockers', prompt: 'What blocked you?', guidelines: 'A specific step' },
        { id: 'q2', key: 'ease', prompt: 'How easy was it?', rationale: 'Sentiment baseline' },
      ],
      sessionId: 's1',
    });
    expect(prompt).toContain('Questionnaire goal: Understand onboarding friction');
    expect(prompt).toContain('Already answered (do not re-tread these):');
    expect(prompt).toContain('- How did you hear about us?');
    expect(prompt).toContain('Looking for: A specific step');
    expect(prompt).toContain('Why it matters: Sentiment baseline');
  });

  it('omits the goal and answered sections when they are absent', () => {
    const prompt = buildSelectorPrompt({
      recentMessages: ['hi'],
      candidates,
      sessionId: 's1',
    });
    expect(prompt).not.toContain('Questionnaire goal:');
    expect(prompt).not.toContain('Already answered');
  });
});

describe('buildAdaptiveDeps — embedText + rankByVector delegation', () => {
  it('embedText returns the embedder vector', async () => {
    (embedText as unknown as Mock).mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    const deps = buildAdaptiveDeps({ userId: 'admin-1' });
    expect(await deps.embedText('hello')).toEqual([0.1, 0.2, 0.3]);
    expect(embedText).toHaveBeenCalledWith('hello', 'query');
  });

  it('rankByVector delegates to the pgvector ranker', async () => {
    (rankSlotsByVector as unknown as Mock).mockResolvedValue(['q2-id']);
    const deps = buildAdaptiveDeps({ userId: 'admin-1' });
    expect(await deps.rankByVector([0.1], ['q1-id', 'q2-id'], 5)).toEqual(['q2-id']);
    expect(rankSlotsByVector).toHaveBeenCalledWith([0.1], ['q1-id', 'q2-id'], 5);
  });

  it('records an embedding inspector trace (when a sink is supplied) without changing the return', async () => {
    (embedText as unknown as Mock).mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      model: 'text-embedding-3-small',
      provider: 'openai',
      dimensions: 1536,
      inputTokens: 7,
      costUsd: 0.0000007,
    });
    const recordInspectorCall = vi.fn();
    const deps = buildAdaptiveDeps({ userId: 'admin-1', recordInspectorCall });

    expect(await deps.embedText('hello')).toEqual([0.1, 0.2, 0.3]);
    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.kind).toBe('embedding');
    expect(trace.label).toBe('Adaptive question ranking');
    expect(trace.dimensions).toBe(1536);
    expect(trace.tokensIn).toBe(7);
  });

  it('omits the trace when no sink is supplied', async () => {
    (embedText as unknown as Mock).mockResolvedValue({ embedding: [0.1], dimensions: 1536 });
    const deps = buildAdaptiveDeps({ userId: 'admin-1' });
    await expect(deps.embedText('hi')).resolves.toEqual([0.1]);
  });
});

describe('buildAdaptiveDeps — llmPick', () => {
  const deps = () => buildAdaptiveDeps({ userId: 'admin-1' });
  const input = { recentMessages: ['hi'], candidates, sessionId: 'sess-1' };

  it('resolves the chosen candidate by 1-based index and propagates cost', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue(
      drainResult({ assistantText: '{"choice": 2, "rationale": "flows"}', costUsd: 0.004 })
    );
    const pick = await deps().llmPick(input);
    expect(pick).toEqual({ questionId: 'q2-id', rationale: 'flows', costUsd: 0.004 });
    // session id threaded into cost-log metadata.
    expect(drainStreamChat).toHaveBeenCalledWith(
      expect.objectContaining({ costLogMetadata: { appQuestionnaireSessionId: 'sess-1' } })
    );
  });

  it('returns a null pick when the selector chooses 0 (none)', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue(
      drainResult({ assistantText: '{"choice": 0, "rationale": "nothing fits"}', costUsd: 0.001 })
    );
    const pick = await deps().llmPick(input);
    expect(pick.questionId).toBeNull();
    expect(pick.rationale).toBe('nothing fits');
  });

  it('returns a null pick for an out-of-range choice', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue(
      drainResult({ assistantText: '{"choice": 9, "rationale": "x"}' })
    );
    expect((await deps().llmPick(input)).questionId).toBeNull();
  });

  it('returns a null pick on a stream error', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue(
      drainResult({ errorCode: 'budget_exceeded', costUsd: 0 })
    );
    const pick = await deps().llmPick(input);
    expect(pick.questionId).toBeNull();
    expect(pick.rationale).toMatch(/budget_exceeded/);
  });

  it('returns a null pick on unparseable output', async () => {
    (drainStreamChat as unknown as Mock).mockResolvedValue(
      drainResult({ assistantText: 'I think question two' })
    );
    const pick = await deps().llmPick(input);
    expect(pick.questionId).toBeNull();
    expect(pick.rationale).toMatch(/unparseable/);
  });
});
