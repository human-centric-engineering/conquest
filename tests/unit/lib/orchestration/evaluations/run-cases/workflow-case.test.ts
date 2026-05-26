/**
 * Unit tests for runWorkflowCase — Phase 3 workflow subject runner.
 *
 * Mocks the workflow engine and Prisma at the module boundary so the
 * test focuses on the runner's contract: load the workflow, drive the
 * engine, resolve the selector, and tag cost rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => {
  const findUniqueWorkflow = vi.fn();
  const findUniqueExecution = vi.fn();
  return {
    prisma: {
      aiWorkflow: { findUnique: findUniqueWorkflow },
      aiWorkflowExecution: { findUnique: findUniqueExecution },
    },
  };
});

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
const { runWorkflowCase } = await import('@/lib/orchestration/evaluations/run-cases/workflow-case');

type PrismaMock = {
  aiWorkflow: { findUnique: ReturnType<typeof vi.fn> };
  aiWorkflowExecution: { findUnique: ReturnType<typeof vi.fn> };
};
const prismaMock = prisma as unknown as PrismaMock;

const DEFINITION = {
  entryStepId: 's1',
  errorStrategy: 'fail',
  steps: [
    {
      id: 's1',
      type: 'llm_call',
      name: 'Reply',
      config: { prompt: 'hi' },
      nextSteps: [],
    },
  ],
} as const;

function publishedWorkflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    isActive: true,
    publishedVersion: {
      id: 'wfv-1',
      snapshot: DEFINITION,
    },
    ...overrides,
  };
}

async function* yieldEvents(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runWorkflowCase — preflight error paths', () => {
  it('returns workflow_id_missing when no workflowId is supplied', async () => {
    const result = await runWorkflowCase({
      workflowId: '',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_id_missing');
    expect(prismaMock.aiWorkflow.findUnique).not.toHaveBeenCalled();
  });

  it('returns workflow_not_found when the row is missing', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(null);

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_not_found');
  });

  it('returns workflow_inactive when the workflow is disabled', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(
      publishedWorkflowRow({ isActive: false })
    );

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_inactive');
  });

  it('returns workflow_not_published when there is no published version', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(
      publishedWorkflowRow({ publishedVersion: null })
    );

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_not_published');
  });

  it('returns workflow_malformed when the published snapshot fails schema validation', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(
      publishedWorkflowRow({
        publishedVersion: { id: 'v', snapshot: { not: 'a workflow' } },
      })
    );

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_malformed');
  });
});

describe('runWorkflowCase — happy path + selector resolution', () => {
  it('drives the engine with costLogMetadata={ evaluationRunId, role: subject } when an evaluationRunId is provided', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'exec-1' },
        { type: 'workflow_completed', totalCostUsd: 0.03, totalTokensUsed: 120, output: 'final' },
      ])
    );
    prismaMock.aiWorkflowExecution.findUnique.mockResolvedValueOnce({
      outputData: null,
      executionTrace: [
        { stepId: 's1', stepType: 'llm_call', status: 'completed', output: 'reply' },
      ],
    });

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'user-1',
      input: { topic: 'taxes' },
      subjectOutputSelector: { kind: 'last_step' },
      evaluationRunId: 'run-7',
    });

    expect(mockEngineExecute).toHaveBeenCalledTimes(1);
    const [workflowArg, inputDataArg, optionsArg] = mockEngineExecute.mock.calls[0] as [
      { id: string; versionId: string },
      Record<string, unknown>,
      { userId: string; costLogMetadata?: Record<string, unknown> },
    ];
    expect(workflowArg.id).toBe('wf-1');
    expect(workflowArg.versionId).toBe('wfv-1');
    expect(inputDataArg).toEqual({ topic: 'taxes' });
    expect(optionsArg.userId).toBe('user-1');
    expect(optionsArg.costLogMetadata).toEqual({ evaluationRunId: 'run-7', role: 'subject' });

    expect(result.errorCode).toBeUndefined();
    expect(result.assistantText).toBe('reply');
    expect(result.costUsd).toBe(0.03);
    expect(result.tokenUsage.input).toBe(120);
  });

  it('omits costLogMetadata when evaluationRunId is absent (engine stays untagged)', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'exec-2' },
        { type: 'workflow_completed', totalCostUsd: 0, totalTokensUsed: 0, output: 'x' },
      ])
    );
    prismaMock.aiWorkflowExecution.findUnique.mockResolvedValueOnce({
      outputData: 'x',
      executionTrace: [{ stepId: 's1', stepType: 'llm_call', status: 'completed', output: 'x' }],
    });

    await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    const optionsArg = mockEngineExecute.mock.calls[0][2] as { costLogMetadata?: unknown };
    expect(optionsArg.costLogMetadata).toBeUndefined();
  });

  it('resolves selector { kind: step_id, stepId: s1 } against the trace', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        { type: 'workflow_completed', totalCostUsd: 0, totalTokensUsed: 0 },
      ])
    );
    prismaMock.aiWorkflowExecution.findUnique.mockResolvedValueOnce({
      outputData: null,
      executionTrace: [
        { stepId: 's1', stepType: 'llm_call', status: 'completed', output: 'step1-out' },
        { stepId: 's2', stepType: 'report', status: 'completed', output: 'step2-out' },
      ],
    });

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'step_id', stepId: 's1' },
    });

    expect(result.assistantText).toBe('step1-out');
  });

  it('returns selector_unresolved when no step matches the selector', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        { type: 'workflow_completed', totalCostUsd: 0, totalTokensUsed: 0 },
      ])
    );
    prismaMock.aiWorkflowExecution.findUnique.mockResolvedValueOnce({
      outputData: null,
      executionTrace: [
        { stepId: 's1', stepType: 'llm_call', status: 'completed', output: 'only-s1' },
      ],
    });

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'step_id', stepId: 'missing-step' },
    });

    expect(result.errorCode).toBe('selector_unresolved');
  });

  it("surfaces workflow_failed with the engine's reason when execution fails", async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        { type: 'workflow_failed', error: 'boom', failedStepId: 's1' },
      ])
    );

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_failed');
    expect(result.errorMessage).toContain('s1');
    expect(result.errorMessage).toContain('boom');
  });

  it('returns workflow_paused_for_approval when the engine yields approval_required', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        { type: 'approval_required', stepId: 's-approval', payload: {} },
      ])
    );

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_paused_for_approval');
    expect(result.errorMessage).toContain('s-approval');
  });

  it('returns workflow_dispatch_failed when the engine throws synchronously', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockImplementationOnce(() => {
      throw new Error('engine boom');
    });

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: { kind: 'last_step' },
    });

    expect(result.errorCode).toBe('workflow_dispatch_failed');
    expect(result.errorMessage).toContain('engine boom');
  });

  it('defaults a missing selector to last_step semantics rather than crashing', async () => {
    prismaMock.aiWorkflow.findUnique.mockResolvedValueOnce(publishedWorkflowRow());
    mockEngineExecute.mockReturnValueOnce(
      yieldEvents([
        { type: 'workflow_started', executionId: 'e' },
        { type: 'workflow_completed', totalCostUsd: 0, totalTokensUsed: 0 },
      ])
    );
    prismaMock.aiWorkflowExecution.findUnique.mockResolvedValueOnce({
      outputData: null,
      executionTrace: [{ stepId: 's1', stepType: 'llm_call', status: 'completed', output: 'last' }],
    });

    const result = await runWorkflowCase({
      workflowId: 'wf-1',
      userId: 'u',
      input: {},
      subjectOutputSelector: null,
    });

    expect(result.errorCode).toBeUndefined();
    expect(result.assistantText).toBe('last');
  });
});
