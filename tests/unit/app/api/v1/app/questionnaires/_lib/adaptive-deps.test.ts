/**
 * Unit test: adaptive-strategy dependency wiring (F4.1 / PR3).
 *
 * Mocks the embedder, the shared selector completion, and the pgvector rank so the prompt builder and
 * the `llmPick` → candidate-resolution logic (incl. every fail-soft branch) are tested without real
 * I/O. The selector now runs as a direct structured completion, so anonymous sessions reach it too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({ embedText: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/selector-completion', () => ({
  runSelectorCompletion: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  rankSlotsByVector: vi.fn(),
}));

import {
  buildAdaptiveDeps,
  buildSelectorPrompt,
} from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { runSelectorCompletion } from '@/app/api/v1/app/questionnaires/_lib/selector-completion';
import { rankSlotsByVector } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';

type Mock = ReturnType<typeof vi.fn>;

const candidates = [
  { id: 'q1-id', key: 'q1', prompt: 'What is your name?' },
  { id: 'q2-id', key: 'q2', prompt: 'Describe your goals.' },
];

/** Build a {@link SelectorCompletionResult}-shaped value for the mocked helper. */
function selResult(
  over: Partial<{
    parsed: { choice: number; rationale: string } | null;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    errorCode: string;
  }> = {}
) {
  return {
    parsed: { choice: 2, rationale: 'flows' },
    model: 'gpt-4o',
    provider: 'openai',
    costUsd: 0.004,
    latencyMs: 1,
    tokensIn: 0,
    tokensOut: 0,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

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
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(
      selResult({ parsed: { choice: 2, rationale: 'flows' }, costUsd: 0.004 })
    );
    const pick = await deps().llmPick(input);
    expect(pick).toEqual({ questionId: 'q2-id', rationale: 'flows', costUsd: 0.004 });
    // session id threaded into the selector completion for cost attribution.
    expect(runSelectorCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1' })
    );
  });

  it('records the selector LLM pick in the inspector when a sink is supplied', async () => {
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(
      selResult({ parsed: { choice: 2, rationale: 'flows' }, costUsd: 0.004 })
    );
    const recordInspectorCall = vi.fn();
    const d = buildAdaptiveDeps({ userId: 'admin-1', recordInspectorCall });
    await d.llmPick(input);

    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.label).toBe('Question selector');
    expect(trace.kind).toBeUndefined(); // an LLM call, not an embedding
    expect(trace.costUsd).toBe(0.004);
    expect(trace.prompt[0].content).toContain('Candidate questions to ask next');
    expect(trace.response).toContain('"choice":2');
  });

  it('returns a null pick when the selector chooses 0 (none)', async () => {
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(
      selResult({ parsed: { choice: 0, rationale: 'nothing fits' }, costUsd: 0.001 })
    );
    const pick = await deps().llmPick(input);
    expect(pick.questionId).toBeNull();
    expect(pick.rationale).toBe('nothing fits');
  });

  it('returns a null pick for an out-of-range choice', async () => {
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(
      selResult({ parsed: { choice: 9, rationale: 'x' } })
    );
    expect((await deps().llmPick(input)).questionId).toBeNull();
  });

  it('returns a null pick on a selector completion error', async () => {
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(
      selResult({ parsed: null, errorCode: 'completion_failed', costUsd: 0 })
    );
    const pick = await deps().llmPick(input);
    expect(pick.questionId).toBeNull();
    expect(pick.rationale).toMatch(/completion_failed/);
  });

  it('returns a null pick on an unparseable (null) result with no error code', async () => {
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(selResult({ parsed: null }));
    const pick = await deps().llmPick(input);
    expect(pick.questionId).toBeNull();
    expect(pick.rationale).toMatch(/unparseable/);
  });

  it('RUNS the selector for an anonymous session (structured completion — no user FK)', async () => {
    // The selector is now a direct structured completion with no persisted conversation, so an
    // anonymous session reaches it and the strategy can use an adaptive pick.
    (runSelectorCompletion as unknown as Mock).mockResolvedValue(
      selResult({ parsed: { choice: 2, rationale: 'flows' }, costUsd: 0.004 })
    );
    const d = buildAdaptiveDeps({ userId: 'anon:sess-1', anonymous: true });
    const pick = await d.llmPick(input);
    expect(pick.questionId).toBe('q2-id');
    expect(runSelectorCompletion).toHaveBeenCalled();
  });
});
