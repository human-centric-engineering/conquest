/**
 * `judge_call` — drive an evaluation judge agent inline as a workflow
 * step. Unlocks QA gates, self-review loops, multi-judge approval, and
 * cost-aware routing — patterns that need a structured `{score,reasoning}`
 * verdict mid-workflow without going through the batch evaluation runner.
 *
 * Config:
 *   - `judgeAgentSlug: string`      — `AiAgent.slug` with `kind='judge'`.
 *   - `question: string`             — the QUESTION payload (template-interpolated).
 *   - `answer: string`               — the ANSWER payload (template-interpolated).
 *   - `expectedOutput?: string`      — optional reference answer (template-interpolated).
 *   - `subjectBrandVoice?: string`   — only honoured by `eval-judge-brand-voice`.
 *
 * Template syntax (`{{stepId.output}}`, `{{input.foo}}`, `{{previous.output}}`)
 * is supported on every string field so a judge can score a prior
 * step's output without the workflow author having to glue the prompt
 * together by hand.
 *
 * Output: `{ score: number | null, reasoning: string, evaluationSteps?: string[],
 *           passed: boolean, threshold: number | null }`.
 * `passed` is `true` when no threshold is set, or when `score >= threshold`.
 * The boolean is the natural anchor for `route` step branching ("publish
 * if passed, escalate otherwise"). Workflows that want to branch on the
 * raw score string-match `{{<this-step-id>.output.score}}` in their
 * route conditions.
 *
 * Cost: the judge call writes one `AiCostLog` row attributed to the
 * judge agent. The engine's `costLogMetadata` propagation (Phase 3) is
 * what tags rows when this step runs inside an evaluation run; outside
 * an eval, the cost rolls into the workflow execution's total via
 * `workflowExecutionId`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { interpolatePrompt } from '@/lib/orchestration/engine/interpolate-prompt';
import { driveJudgeAgent } from '@/lib/orchestration/evaluations/judge-driver';
import { judgeCallConfigSchema } from '@/lib/validations/orchestration';

export async function executeJudgeCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = judgeCallConfigSchema.parse(step.config);

  const judgeAgentSlug = config.judgeAgentSlug.trim();
  if (judgeAgentSlug.length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_judge_agent_slug',
      'judge_call step is missing a judgeAgentSlug'
    );
  }

  // Judge calls write `AiCostLog` rows attributed to the judge agent +
  // user, so the workflow must be running on behalf of a real user.
  // System-context executions (scheduler tick without a user) can't use
  // judge_call — surface a typed error rather than silently writing to
  // a null user.
  if (ctx.userId === null) {
    throw new ExecutorError(
      step.id,
      'judge_call_requires_user_context',
      'judge_call needs a user-scoped execution context; this workflow is running without a userId.'
    );
  }

  // Template-interpolate every string field so a workflow author can
  // pull values out of prior step outputs without external glue.
  // `interpolatePrompt` returns the empty string for missing refs —
  // matches the engine-wide template behaviour.
  const question = interpolatePrompt(config.question, ctx);
  const answer = interpolatePrompt(config.answer, ctx);
  const expectedOutput =
    typeof config.expectedOutput === 'string'
      ? interpolatePrompt(config.expectedOutput, ctx)
      : undefined;
  const subjectBrandVoice =
    typeof config.subjectBrandVoice === 'string'
      ? interpolatePrompt(config.subjectBrandVoice, ctx)
      : undefined;

  const result = await driveJudgeAgent({
    agentSlug: judgeAgentSlug,
    userId: ctx.userId,
    question,
    answer,
    ...(expectedOutput && expectedOutput.length > 0 ? { expectedOutput } : {}),
    ...(subjectBrandVoice && subjectBrandVoice.length > 0 ? { subjectBrandVoice } : {}),
    // Don't double-tag: when the step runs inside an evaluation run,
    // `ExecuteOptions.costLogMetadata` already tags every cost row via
    // the executors' merged metadata. The grader path is different —
    // it runs outside an engine context and has to tag explicitly.
  });

  const threshold = typeof config.threshold === 'number' ? config.threshold : null;
  const passed =
    typeof result.score === 'number' && threshold !== null ? result.score >= threshold : true;

  const output: Record<string, unknown> = {
    score: result.score,
    reasoning: result.reasoning,
    passed,
    threshold,
    judgeAgentSlug,
  };
  if (result.evaluationSteps && result.evaluationSteps.length > 0) {
    output.evaluationSteps = result.evaluationSteps;
  }
  if (result.errorCode) {
    output.errorCode = result.errorCode;
  }

  return {
    output,
    tokensUsed: result.tokenUsage.input + result.tokenUsage.output,
    costUsd: result.costUsd,
  };
}

registerStepType('judge_call', executeJudgeCall);
