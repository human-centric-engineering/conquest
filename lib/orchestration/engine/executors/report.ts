/**
 * `report` — deterministic Markdown render of the in-flight trace.
 *
 * Reads `ctx.stepOutputs` + workflow metadata and emits a structured
 * Markdown document via `renderExecutionMarkdown`. The output goes
 * into `stepOutputs[stepId].markdown` so a downstream
 * `send_notification` step can interpolate it into the email body.
 *
 * Subtlety: in-step rendering only sees the trace *up to and
 * including the prior step* — the report step's own entry won't be
 * there yet (which is correct — you don't want the report to describe
 * the report-rendering step). For a complete trace including the
 * report step, use the on-demand download endpoint.
 *
 * Run-time toggle: when `respectRuntimeOptOut` is true (default) and
 * `ctx.inputData.__generateReport === false`, the step short-circuits
 * with `expectedSkip: true`. Same UX pattern as the supervisor's
 * `__runSupervisor` toggle.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { StepResult, WorkflowStep, ExecutionTraceEntry } from '@/types/orchestration';
import { reportConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { renderExecutionMarkdown } from '@/lib/orchestration/trace/render-markdown';
import { logger } from '@/lib/logging';

export function executeReport(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = reportConfigSchema.parse(step.config);

  const respectOptOut = config.respectRuntimeOptOut ?? true;
  if (respectOptOut && ctx.inputData.__generateReport === false) {
    logger.info('report skipped — __generateReport=false', {
      executionId: ctx.executionId,
      stepId: step.id,
    });
    return Promise.resolve({
      output: { skipped: true, reason: 'report generation disabled at trigger time' },
      tokensUsed: 0,
      costUsd: 0,
      skipped: true,
      expectedSkip: true,
    });
  }

  // Synthesise a `RenderExecutionInfo` from the engine context. The
  // executor doesn't have access to the full DB row (the engine
  // doesn't pass it through), so a few fields are unset and the
  // renderer's defaults take over. The on-demand download endpoint
  // (Phase 6 GET handler) passes a richer object.
  const renderInfo = {
    id: ctx.executionId,
    workflowId: ctx.workflowId,
    workflowName: null,
    status: 'running' as const,
    totalTokensUsed: ctx.totalTokensUsed,
    totalCostUsd: ctx.totalCostUsd,
    startedAt: null,
    completedAt: null,
    inputData: ctx.inputData,
    outputData: null,
    errorMessage: null,
  };

  // Trace projection — derive from stepOutputs map (the engine's
  // source of truth at execution time). Each entry gets minimal
  // metadata; the on-demand renderer pulls the full ExecutionTraceEntry
  // shape from the persisted row.
  const trace: ExecutionTraceEntry[] = Object.keys(ctx.stepOutputs).map((stepId) => ({
    stepId,
    stepType: 'unknown',
    label: stepId,
    status: 'completed' as const,
    output: ctx.stepOutputs[stepId],
    durationMs: 0,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
  }));

  const markdown = renderExecutionMarkdown(renderInfo, trace, {
    includeStepOutputs: config.includeStepOutputs ?? 'auto',
  });

  return Promise.resolve({
    output: {
      markdown,
      byteLength: Buffer.byteLength(markdown, 'utf8'),
      generatedAt: new Date().toISOString(),
    },
    tokensUsed: 0,
    costUsd: 0,
  });
}

registerStepType('report', executeReport);
