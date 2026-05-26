/**
 * Tests for the pairwise_judge_agent grader.
 *
 * Mocks drainStreamChat at the module boundary so the test focuses on:
 *   - Building the structured prompt with A/B labelling.
 *   - Parsing { verdict, reasoning } JSON envelope.
 *   - Cost-tagging via judge.evaluationRunId.
 *   - Graceful fallbacks when the judge errors or returns garbage
 *     (default-to-tie keeps the experiment compare flow alive).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({
  drainStreamChat: vi.fn(),
}));

const { drainStreamChat } = await import('@/lib/orchestration/evaluations/drain-stream-chat');
const { pairwiseJudgeAgentGrader } =
  await import('@/lib/orchestration/evaluations/graders/pairwise/judge-agent');

const mockedDrain = drainStreamChat as unknown as ReturnType<typeof vi.fn>;

function drainOk(overrides: Record<string, unknown> = {}) {
  return {
    assistantText: '{"verdict":"A","reasoning":"A is more concise and accurate."}',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 80, output: 20 },
    costUsd: 0.02,
    latencyMs: 250,
    ...overrides,
  };
}

function drainErr(overrides: Record<string, unknown> = {}) {
  return {
    assistantText: '',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 4, output: 0 },
    costUsd: 0.0001,
    latencyMs: 25,
    errorCode: 'PROVIDER_DOWN',
    errorMessage: 'Anthropic returned 503',
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    userInput: 'What is 2+2?',
    outputA: 'It is 4.',
    outputB: 'Four.',
    config: { judgeAgentSlug: 'eval-judge-correctness' },
    judge: { userId: 'user-1', evaluationRunId: 'run-7' },
    ...overrides,
  };
}

describe('pairwise_judge_agent — registry metadata', () => {
  it('registers as family=pairwise', () => {
    expect(pairwiseJudgeAgentGrader.slug).toBe('pairwise_judge_agent');
    expect(pairwiseJudgeAgentGrader.family).toBe('pairwise');
  });
});

describe('pairwise_judge_agent — drainStreamChat dispatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds a QUESTION/A/B/EXPECTED prompt and passes it to drainStreamChat', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await pairwiseJudgeAgentGrader.grade(input({ expectedOutput: 'The answer is 4.' }));

    expect(mockedDrain).toHaveBeenCalledTimes(1);
    const call = mockedDrain.mock.calls[0][0];
    expect(call.agentSlug).toBe('eval-judge-correctness');
    expect(call.userId).toBe('user-1');
    expect(call.message).toContain('QUESTION: What is 2+2?');
    expect(call.message).toContain('ANSWER A: It is 4.');
    expect(call.message).toContain('ANSWER B: Four.');
    expect(call.message).toContain('EXPECTED ANSWER: The answer is 4.');
    expect(call.message).toMatch(/JSON/);
  });

  it('passes costLogMetadata with role=judge + judgeAgentSlug when evaluationRunId is set', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await pairwiseJudgeAgentGrader.grade(input());

    const call = mockedDrain.mock.calls[0][0];
    expect(call.costLogMetadata).toEqual({
      evaluationRunId: 'run-7',
      role: 'judge',
      judgeAgentSlug: 'eval-judge-correctness',
    });
  });

  it('omits costLogMetadata when no evaluationRunId is present on judge context', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await pairwiseJudgeAgentGrader.grade(input({ judge: { userId: 'user-1' } }));

    const call = mockedDrain.mock.calls[0][0];
    expect(call).not.toHaveProperty('costLogMetadata');
  });
});

describe('pairwise_judge_agent — verdict parsing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns verdict=A with reasoning + cost + tokens on a clean response', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    const r = await pairwiseJudgeAgentGrader.grade(input());

    expect(r.verdict).toBe('A');
    expect(r.reasoning).toContain('A is more concise');
    expect(r.costUsd).toBe(0.02);
    expect(r.tokenUsage).toEqual({ input: 80, output: 20 });
  });

  it('accepts verdict=B', async () => {
    mockedDrain.mockResolvedValueOnce(
      drainOk({ assistantText: '{"verdict":"B","reasoning":"B wins."}' })
    );

    const r = await pairwiseJudgeAgentGrader.grade(input());

    expect(r.verdict).toBe('B');
  });

  it('accepts verdict=tie', async () => {
    mockedDrain.mockResolvedValueOnce(
      drainOk({ assistantText: '{"verdict":"tie","reasoning":"Both equivalent."}' })
    );

    const r = await pairwiseJudgeAgentGrader.grade(input());

    expect(r.verdict).toBe('tie');
  });

  it('defaults to tie + descriptive reasoning when the response is malformed JSON', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk({ assistantText: 'I think A is best (no JSON)' }));

    const r = await pairwiseJudgeAgentGrader.grade(input());

    expect(r.verdict).toBe('tie');
    expect(r.reasoning).toMatch(/not valid \{verdict, reasoning\} JSON/);
  });

  it('defaults to tie + an error reasoning when drainStreamChat errors', async () => {
    mockedDrain.mockResolvedValueOnce(drainErr());

    const r = await pairwiseJudgeAgentGrader.grade(input());

    expect(r.verdict).toBe('tie');
    expect(r.reasoning).toMatch(/PROVIDER_DOWN/);
    expect(r.reasoning).toMatch(/Anthropic returned 503/);
  });

  it('defaults to tie when judge context is missing entirely (skip path)', async () => {
    const r = await pairwiseJudgeAgentGrader.grade({
      userInput: 'q',
      outputA: 'a',
      outputB: 'b',
      config: { judgeAgentSlug: 'x' },
    });

    expect(r.verdict).toBe('tie');
    expect(r.reasoning).toMatch(/no judge user context/);
    expect(mockedDrain).not.toHaveBeenCalled();
  });
});
