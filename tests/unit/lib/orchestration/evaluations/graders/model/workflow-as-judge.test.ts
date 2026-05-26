/**
 * Tests for the workflow_as_judge grader.
 *
 * Mocks Prisma + the OrchestrationEngine at module boundaries so the
 * test focuses on:
 *   - Preflight checks (not found / inactive / unpublished / malformed).
 *   - Input mapping ($.userInput / $.modelOutput / $.expectedOutput).
 *   - Cost-tagging via judge.evaluationRunId.
 *   - Parsing the workflow's final-step output as { score, reasoning }.
 *   - Graceful null-score fallbacks on workflow failure / bad envelope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findFirst: vi.fn() },
  },
}));

const mockEngineExecute =
  vi.fn<(arg: unknown, input: unknown, opts: unknown) => AsyncIterable<unknown>>();

vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: class MockOrchestrationEngine {
    execute(...args: unknown[]): AsyncIterable<unknown> {
      return mockEngineExecute(args[0], args[1], args[2]);
    }
  },
}));

const { prisma } = await import('@/lib/db/client');
const { workflowAsJudgeGrader } =
  await import('@/lib/orchestration/evaluations/graders/model/workflow-as-judge');

type PrismaMock = { aiWorkflow: { findFirst: ReturnType<typeof vi.fn> } };
const prismaMock = prisma as unknown as PrismaMock;

const JUDGE_DEFINITION = {
  entryStepId: 's1',
  errorStrategy: 'fail',
  steps: [
    {
      id: 's1',
      type: 'llm_call',
      name: 'Score',
      config: { prompt: 'rate this' },
      nextSteps: [],
    },
  ],
} as const;

function publishedWorkflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-judge-1',
    isActive: true,
    publishedVersion: {
      id: 'wfv-judge-1',
      snapshot: JUDGE_DEFINITION,
    },
    ...overrides,
  };
}

async function* yieldEvents(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    userInput: 'q',
    modelOutput: 'a',
    expectedOutput: 'ref',
    config: {
      workflowSlug: 'critique-answer',
      inputMapping: {
        question: '$.userInput' as const,
        answer: '$.modelOutput' as const,
        reference: '$.expectedOutput' as const,
      },
    },
    judge: { userId: 'user-1', evaluationRunId: 'run-9' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workflow_as_judge — registry metadata', () => {
  it('registers as model family with the expected slug', () => {
    expect(workflowAsJudgeGrader.slug).toBe('workflow_as_judge');
    expect(workflowAsJudgeGrader.family).toBe('model');
  });
});

describe('workflow_as_judge — preflight error paths', () => {
  it('returns score=null + skip reason when no judge user context is provided', async () => {
    const r = await workflowAsJudgeGrader.grade({
      userInput: 'q',
      modelOutput: 'a',
      config: { workflowSlug: 'x', inputMapping: {} },
    });

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/no judge user context/);
    expect(prismaMock.aiWorkflow.findFirst).not.toHaveBeenCalled();
  });

  it('returns null + descriptive reason when the workflow is not found', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(null);

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/not found/);
  });

  it('returns null when the workflow is inactive', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(
      publishedWorkflowRow({ isActive: false })
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/inactive/);
  });

  it('returns null when the workflow has no published version', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(
      publishedWorkflowRow({ publishedVersion: null })
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/no published version/);
  });

  it('returns null when the workflow definition fails schema validation', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(
      publishedWorkflowRow({
        publishedVersion: { id: 'v', snapshot: { not: 'a workflow' } },
      })
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/malformed/);
  });
});

describe('workflow_as_judge — happy path', () => {
  it('maps case fields into the workflow variables and drives the engine', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'exec-1' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0.05,
          totalTokensUsed: 200,
          output: '{"score": 0.9, "reasoning": "nailed it"}',
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(mockEngineExecute).toHaveBeenCalledTimes(1);
    const [, inputData, options] = mockEngineExecute.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      { userId: string; costLogMetadata?: Record<string, unknown> },
    ];
    expect(inputData).toEqual({ question: 'q', answer: 'a', reference: 'ref' });
    expect(options.userId).toBe('user-1');
    expect(options.costLogMetadata).toEqual({
      evaluationRunId: 'run-9',
      role: 'judge',
      judgeWorkflowSlug: 'critique-answer',
    });

    expect(r.score).toBeCloseTo(0.9);
    expect(r.reasoning).toBe('nailed it');
    expect(r.costUsd).toBe(0.05);
  });

  it('parses a JSON object output directly without going through string-parse', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          // Object outputs are JSON.stringify'd by the runner before parse —
          // the contract is "the parser accepts either string or object".
          output: { score: 0.3, reasoning: 'meh' },
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeCloseTo(0.3);
    expect(r.reasoning).toBe('meh');
  });

  it('propagates evaluationSteps onto the GraderResult when the judge workflow returns them', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: '{"score": 1.0, "reasoning": "great", "evaluation_steps": ["a", "b"]}',
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.evaluationSteps).toEqual(['a', 'b']);
  });
});

describe('workflow_as_judge — failure modes', () => {
  it('returns null + workflow-failed reasoning when the engine emits workflow_failed', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        { type: 'workflow_failed', error: 'boom', failedStepId: 's1' },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toContain('s1');
    expect(r.reasoning).toContain('boom');
  });

  it('returns null + parse-error reasoning when the workflow output is not a {score, reasoning} envelope', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: 'just a plain string',
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/not a \{score, reasoning\} envelope/);
  });

  it('returns null + engine-threw reasoning when the engine throws synchronously', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockImplementationOnce(() => {
      throw new Error('engine blew up');
    });

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/engine threw/);
    expect(r.reasoning).toContain('engine blew up');
  });
});

describe('workflow_as_judge — input mapping + signal forwarding', () => {
  it('resolves $.citations to an empty array when no citations are present', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: '{"score": 1.0, "reasoning": "ok"}',
        },
      ])
    );

    await workflowAsJudgeGrader.grade({
      userInput: 'q',
      modelOutput: 'a',
      config: {
        workflowSlug: 'critique-answer',
        inputMapping: { sources: '$.citations' },
      },
      judge: { userId: 'user-1' },
    });

    const [, inputData] = mockEngineExecute.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      unknown,
    ];
    expect(Array.isArray(inputData.sources)).toBe(true);
    expect(inputData.sources).toEqual([]);
  });

  it('resolves $.expectedOutput to an empty string when expectedOutput is undefined', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: '{"score": 0.5, "reasoning": "ok"}',
        },
      ])
    );

    await workflowAsJudgeGrader.grade({
      userInput: 'q',
      modelOutput: 'a',
      // expectedOutput omitted on purpose — the mapping should yield ''
      config: {
        workflowSlug: 'critique-answer',
        inputMapping: { ref: '$.expectedOutput' },
      },
      judge: { userId: 'user-1' },
    });

    const [, inputData] = mockEngineExecute.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      unknown,
    ];
    expect(inputData.ref).toBe('');
  });

  it('forwards an AbortSignal to the engine when input.signal is provided', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: '{"score": 0.7, "reasoning": "ok"}',
        },
      ])
    );

    const controller = new AbortController();
    await workflowAsJudgeGrader.grade({
      ...input(),
      signal: controller.signal,
    });

    const [, , options] = mockEngineExecute.mock.calls[0] as [
      unknown,
      unknown,
      { signal?: AbortSignal },
    ];
    expect(options.signal).toBe(controller.signal);
  });

  it('omits costLogMetadata from engine options when judge.evaluationRunId is absent', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: '{"score": 0.5, "reasoning": "ok"}',
        },
      ])
    );

    await workflowAsJudgeGrader.grade({
      userInput: 'q',
      modelOutput: 'a',
      config: { workflowSlug: 'critique-answer', inputMapping: {} },
      judge: { userId: 'user-1' },
    });

    const [, , options] = mockEngineExecute.mock.calls[0] as [
      unknown,
      unknown,
      { costLogMetadata?: unknown },
    ];
    expect(options.costLogMetadata).toBeUndefined();
  });

  it('returns parse-error reasoning when the workflow output is an array (not a {score, reasoning} envelope)', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          // Arrays land in the JSON.stringify branch of the rawForParse IIFE
          // but won't parse as a {score, reasoning} envelope.
          output: [1, 2, 3],
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/not a \{score, reasoning\} envelope/);
  });

  it('returns parse-error reasoning when the workflow output is null/undefined', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: null,
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/not a \{score, reasoning\} envelope/);
  });

  it('returns parse-error reasoning when the workflow output is a number primitive', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'workflow_completed',
          totalCostUsd: 0,
          totalTokensUsed: 0,
          output: 42,
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/not a \{score, reasoning\} envelope/);
  });

  it('falls back to step_completed output when no workflow_completed event carries output', async () => {
    prismaMock.aiWorkflow.findFirst.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        {
          type: 'step_completed',
          stepId: 's1',
          output: '{"score": 0.6, "reasoning": "from step"}',
        },
        {
          type: 'workflow_completed',
          totalCostUsd: 0.01,
          totalTokensUsed: 10,
          // no `output` field — runner falls back to lastStepOutput
        },
      ])
    );

    const r = await workflowAsJudgeGrader.grade(input());

    expect(r.score).toBeCloseTo(0.6);
    expect(r.reasoning).toBe('from step');
  });
});
