/**
 * `supervisor` — neutral post-hoc audit of a workflow execution.
 *
 * Reads a compacted projection of the execution trace and returns a
 * structured verdict with evidence-cited weaknesses. The supervisor is
 * advisory by default; opt in to terminating the workflow on a `fail`
 * verdict via `failOnVerdict: 'fail'`.
 *
 * Anti-optimism mechanics (the reason this step exists):
 *  - Independent judge model via `JUDGE_MODEL` (env-configurable;
 *    judge ≥ subject is standard practice).
 *  - Structured JSON output forced via `responseFormat: { type: 'json_schema' }`.
 *  - Post-hoc citation validator: every cited `evidenceStepId` must
 *    exist in `ctx.stepOutputs` and every `evidenceQuote` must substring-
 *    match the cited step's output. Invalid citations are stripped; if
 *    stripping breaches the `minWeaknesses` floor the verdict downgrades
 *    (`pass` → `concerns`, `concerns` → `fail`).
 *  - `minWeaknesses` floor — no silent passes.
 *  - `unverifiedAreas[]` — supervisor must declare what it couldn't assess.
 *  - Low temperature (0.2) with one retry at temperature 0 on parse failure.
 *
 * Run-time toggle: when `respectRuntimeOptOut` is true (default) and
 * `ctx.inputData.__runSupervisor === false`, the step short-circuits
 * with `expectedSkip: true`. This is how the run dialog's "Run supervisor"
 * checkbox opts out per-execution without modifying the template.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { z } from 'zod';

import type {
  StepResult,
  SupervisorReport,
  SupervisorVerdict,
  WorkflowStep,
} from '@/types/orchestration';
import { supervisorConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { JUDGE_MODEL } from '@/lib/orchestration/evaluations/judge-model';
import { logger } from '@/lib/logging';

// ─── Truncation strategy ────────────────────────────────────────────────────
// Phase 6 extracts this to `lib/orchestration/trace/truncate.ts` and shares it
// with the deterministic Markdown renderer. Inlined here for Phase 1 so the
// executor has no extra moving parts.

const DEFAULT_PER_STEP_CAP_BYTES = 4 * 1024;
const TERMINAL_HEAD_CAP_BYTES = 1024;

/**
 * Sample head + middle + tail of a string when it exceeds `capBytes`.
 * Elision markers tell the model what's missing so it doesn't pretend
 * it saw the elided content. Returns the original string when small.
 */
function sampleString(input: string, capBytes: number): string {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes <= capBytes) return input;
  const sliceBytes = Math.floor(capBytes / 3);
  const head = input.slice(0, sliceBytes);
  const mid = input.slice(
    Math.floor(input.length / 2 - sliceBytes / 2),
    Math.floor(input.length / 2 + sliceBytes / 2)
  );
  const tail = input.slice(-sliceBytes);
  const elidedBytes = bytes - 3 * sliceBytes;
  return (
    `${head}\n` +
    `[…truncated, ${elidedBytes} bytes elided from head/middle boundary…]\n` +
    `${mid}\n` +
    `[…truncated, bytes elided from middle/tail boundary…]\n` +
    `${tail}`
  );
}

function serialiseStepOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch (err) {
    return `(could not serialize step output: ${err instanceof Error ? err.message : 'unknown error'})`;
  }
}

// ─── Trace projection ───────────────────────────────────────────────────────

interface ProjectedStep {
  stepId: string;
  output: string;
  outputBytes: number;
}

/**
 * Build the trace projection passed into the supervisor's prompt.
 *
 * The projection uses `ctx.stepOutputs` (a map of step id → output) as
 * the source of truth — the supervisor only sees outputs of steps that
 * already completed, which is correct for a terminal-position step.
 */
function buildProjection(
  ctx: Readonly<ExecutionContext>,
  mode: 'auto' | 'all' | 'terminal-only'
): { projection: ProjectedStep[]; mostRecentStepId: string | null } {
  const stepIds = Object.keys(ctx.stepOutputs);
  if (stepIds.length === 0) return { projection: [], mostRecentStepId: null };
  const mostRecent = stepIds[stepIds.length - 1];

  const projection: ProjectedStep[] = stepIds.map((stepId) => {
    const raw = serialiseStepOutput(ctx.stepOutputs[stepId]);
    const bytes = Buffer.byteLength(raw, 'utf8');
    let truncated: string;
    if (mode === 'all') {
      truncated = raw;
    } else if (mode === 'terminal-only') {
      truncated = stepId === mostRecent ? raw : sampleString(raw, TERMINAL_HEAD_CAP_BYTES);
    } else {
      truncated = sampleString(raw, DEFAULT_PER_STEP_CAP_BYTES);
    }
    return { stepId, output: truncated, outputBytes: bytes };
  });

  return { projection, mostRecentStepId: mostRecent };
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

const DEFAULT_RED_TEAM_PROMPTS = [
  'Silent retries that succeeded only after the budget was nearly exhausted.',
  'Steps with `expectedSkip: false` that failed — were they routine or signal?',
  'Internal contradictions across step outputs (step A claims X, step B asserts not-X).',
  'Guard / validator steps that passed despite obvious data issues.',
  'Capability calls that returned a success shape but applied zero changes.',
  'Reflect / agent loops that hit max iterations without converging.',
  'Inputs derived from missing fields where the executor silently substituted defaults.',
] as const;

const CALIBRATION_ANCHORS = `
Calibration anchors:
- PASS: every assertion the workflow makes is traceable to a step's output;
  no step failed unexpectedly; the final outcome matches the stated objective;
  the supervisor has at least one weakness/observation drawn from the trace
  (even healthy runs have small things to note).
- CONCERNS: the workflow likely succeeded but at least one of these is true:
  some claims lack solid evidence, an "expected" skip masked a real failure,
  reflection iterations were near the cap, or capability returns were not
  cross-checked against subsequent steps.
- FAIL: the workflow's terminal output contradicts an upstream step,
  a critical step failed silently, a guard let through data the rubric
  forbids, OR the supervisor cannot ground any of its assessment in the
  trace (a free-floating "looks fine to me" verdict counts as FAIL because
  it indicates the audit didn't actually happen).

Wrong-pass anti-example (DO NOT do this):
- A workflow that retried a step five times and got a degraded answer on the
  sixth attempt is NOT a pass. The fact that the final step has an output is
  not evidence that the workflow performed well. The retry storm itself is
  the signal.
`.trim();

function buildPrompt(params: {
  assessmentCriteria: string;
  redTeamPrompts: readonly string[];
  minWeaknesses: number;
  projection: ProjectedStep[];
  inputData: unknown;
  outputData: unknown;
  workflowId: string;
  executionId: string;
}): string {
  const redTeamBlock = params.redTeamPrompts.map((p, i) => `  ${i + 1}. ${p}`).join('\n');

  const projectionBlock = params.projection
    .map(
      (s) =>
        `### Step: ${s.stepId}\nOutput (${s.outputBytes} bytes total, may be truncated):\n${s.output}`
    )
    .join('\n\n---\n\n');

  const inputBlock = ((): string => {
    try {
      return JSON.stringify(params.inputData, null, 2);
    } catch (err) {
      return `(could not serialize inputData: ${err instanceof Error ? err.message : 'unknown'})`;
    }
  })();

  const outputBlock = ((): string => {
    if (params.outputData === null || params.outputData === undefined) {
      return '(workflow has not produced a terminal outputData — supervisor is running mid-workflow or before finalize)';
    }
    try {
      return JSON.stringify(params.outputData, null, 2);
    } catch (err) {
      return `(could not serialize outputData: ${err instanceof Error ? err.message : 'unknown'})`;
    }
  })();

  return [
    `You are a neutral supervisor auditing the execution of a workflow. Your job is to deliver an honest, calibrated verdict on whether the workflow did its job. You are NOT the workflow's author. You have no incentive to make the workflow look good.`,
    ``,
    `Workflow execution id: ${params.executionId}`,
    `Workflow id: ${params.workflowId}`,
    ``,
    `## Assessment criteria (rubric — what "doing its job" means)`,
    params.assessmentCriteria,
    ``,
    `## Red-team checklist — at minimum, check for these failure modes:`,
    redTeamBlock,
    ``,
    CALIBRATION_ANCHORS,
    ``,
    `## Workflow inputData`,
    '```json',
    inputBlock,
    '```',
    ``,
    `## Workflow outputData`,
    '```json',
    outputBlock,
    '```',
    ``,
    `## Trace projection — every step that has completed so far, with truncated outputs`,
    projectionBlock || '(no steps in trace yet)',
    ``,
    `## Output requirements`,
    `Return a single JSON object matching this shape (NO prose around it, NO code fences):`,
    `{`,
    `  "verdict": "pass" | "concerns" | "fail",`,
    `  "score": number between 0 and 1,`,
    `  "summary": short paragraph stating the verdict and its load-bearing reason,`,
    `  "strengths": [ { "claim": "...", "evidenceStepId": "<stepId>", "evidenceQuote": "<verbatim substring of that step's output>" } ],`,
    `  "weaknesses": [ { "severity": "low"|"medium"|"high", "claim": "...", "evidenceStepId": "<stepId>"|null, "evidenceQuote": "<verbatim substring>"|null, "recommendation": "..." } ],`,
    `  "anomalies": [ { "stepId": "<stepId>", "observation": "..." } ],`,
    `  "unverifiedAreas": [ "<thing you could not assess>", ... ],`,
    `  "confidence": "low" | "medium" | "high"`,
    `}`,
    ``,
    `Hard requirements:`,
    `1. EVERY evidenceQuote must be a verbatim substring of the cited step's output. If you cannot quote, set evidenceQuote to null only inside weaknesses (never inside strengths).`,
    `2. weaknesses[] must contain at least ${params.minWeaknesses} entr${params.minWeaknesses === 1 ? 'y' : 'ies'}. If you genuinely find no defects, add a single entry with severity "low", evidenceStepId null, claim "no defects found and the following steps were verified: <list every stepId>", and evidenceQuote null. Do NOT use this escape hatch unless you actually verified every step.`,
    `3. unverifiedAreas[] lists what you could NOT assess. Be honest — an empty array means you verified everything, and you'll be judged on that.`,
    `4. Use trace evidence. A verdict not grounded in specific step outputs is a FAIL by definition.`,
  ].join('\n');
}

// ─── JSON parsing & schema validation ──────────────────────────────────────

const reportShapeSchema = z.object({
  verdict: z.enum(['pass', 'concerns', 'fail']),
  score: z.number().min(0).max(1),
  summary: z.string().min(1),
  strengths: z
    .array(
      z.object({
        claim: z.string().min(1),
        evidenceStepId: z.string().min(1),
        evidenceQuote: z.string().min(1),
      })
    )
    .default([]),
  weaknesses: z
    .array(
      z.object({
        severity: z.enum(['low', 'medium', 'high']),
        claim: z.string().min(1),
        evidenceStepId: z.string().nullable(),
        evidenceQuote: z.string().nullable(),
        recommendation: z.string().min(1),
      })
    )
    .default([]),
  anomalies: z
    .array(z.object({ stepId: z.string().min(1), observation: z.string().min(1) }))
    .default([]),
  unverifiedAreas: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
});

type ParsedReport = z.infer<typeof reportShapeSchema>;

/**
 * Strip JSON code fences if the model wrapped its response. Defensive
 * cleanup — the prompt asks for raw JSON but providers occasionally
 * disregard that.
 */
function stripFences(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('```')) {
    const firstNl = trimmed.indexOf('\n');
    const last = trimmed.lastIndexOf('```');
    if (firstNl !== -1 && last > firstNl) {
      return trimmed.slice(firstNl + 1, last).trim();
    }
  }
  return trimmed;
}

function tryParse(content: string): ParsedReport | null {
  const cleaned = stripFences(content);
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = reportShapeSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ─── Citation validator ─────────────────────────────────────────────────────

interface ValidationResult {
  validatedReport: SupervisorReport;
  downgraded: boolean;
}

const VERDICT_DOWNGRADE: Record<SupervisorVerdict, SupervisorVerdict> = {
  pass: 'concerns',
  concerns: 'fail',
  fail: 'fail',
  inconclusive: 'inconclusive',
};

/**
 * Verify each citation grounds in `stepOutputs`. Strips citations whose
 * `evidenceStepId` is unknown or whose `evidenceQuote` is not a verbatim
 * substring of the cited step's output. If the weakness floor breaks,
 * the verdict downgrades.
 */
function validateCitations(
  parsed: ParsedReport,
  stepOutputs: Record<string, unknown>,
  minWeaknesses: number,
  requireEvidenceCitations: boolean
): ValidationResult {
  const invalidCitations: NonNullable<SupervisorReport['invalidCitations']> = [];

  const validStrengths: SupervisorReport['strengths'] = [];
  parsed.strengths.forEach((s, index) => {
    if (!requireEvidenceCitations) {
      validStrengths.push(s);
      return;
    }
    const stepOut = stepOutputs[s.evidenceStepId];
    if (stepOut === undefined) {
      invalidCitations.push({
        location: 'strength',
        index,
        reason: 'unknown_step_id',
        evidenceStepId: s.evidenceStepId,
        evidenceQuote: s.evidenceQuote,
      });
      return;
    }
    if (!serialiseStepOutput(stepOut).includes(s.evidenceQuote)) {
      invalidCitations.push({
        location: 'strength',
        index,
        reason: 'quote_not_found',
        evidenceStepId: s.evidenceStepId,
        evidenceQuote: s.evidenceQuote,
      });
      return;
    }
    validStrengths.push(s);
  });

  const validWeaknesses: SupervisorReport['weaknesses'] = [];
  parsed.weaknesses.forEach((w, index) => {
    if (!requireEvidenceCitations) {
      validWeaknesses.push(w);
      return;
    }
    // A weakness without a citation is allowed only when the supervisor
    // explicitly declares "no defects found, verified steps: ..." (the
    // minWeaknesses-floor escape hatch). We accept null/null on weaknesses;
    // we only validate when both fields are non-null.
    if (w.evidenceStepId === null && w.evidenceQuote === null) {
      validWeaknesses.push(w);
      return;
    }
    if (w.evidenceStepId === null || w.evidenceQuote === null) {
      invalidCitations.push({
        location: 'weakness',
        index,
        reason: 'unknown_step_id',
        evidenceStepId: w.evidenceStepId ?? '',
        evidenceQuote: w.evidenceQuote ?? '',
      });
      return;
    }
    const stepOut = stepOutputs[w.evidenceStepId];
    if (stepOut === undefined) {
      invalidCitations.push({
        location: 'weakness',
        index,
        reason: 'unknown_step_id',
        evidenceStepId: w.evidenceStepId,
        evidenceQuote: w.evidenceQuote,
      });
      return;
    }
    if (!serialiseStepOutput(stepOut).includes(w.evidenceQuote)) {
      invalidCitations.push({
        location: 'weakness',
        index,
        reason: 'quote_not_found',
        evidenceStepId: w.evidenceStepId,
        evidenceQuote: w.evidenceQuote,
      });
      return;
    }
    validWeaknesses.push(w);
  });

  const downgraded = validWeaknesses.length < minWeaknesses;
  const verdict: SupervisorVerdict = downgraded
    ? VERDICT_DOWNGRADE[parsed.verdict]
    : parsed.verdict;

  const validatedReport: SupervisorReport = {
    verdict,
    score: parsed.score,
    summary: parsed.summary,
    strengths: validStrengths,
    weaknesses: validWeaknesses,
    anomalies: parsed.anomalies,
    unverifiedAreas: parsed.unverifiedAreas,
    confidence: parsed.confidence,
    ...(invalidCitations.length > 0 ? { invalidCitations } : {}),
  };

  return { validatedReport, downgraded };
}

// ─── Executor ───────────────────────────────────────────────────────────────

export async function executeSupervisor(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = supervisorConfigSchema.parse(step.config);

  // Run-time toggle. Default behaviour when key is absent: run.
  const respectOptOut = config.respectRuntimeOptOut ?? true;
  if (respectOptOut && ctx.inputData.__runSupervisor === false) {
    logger.info('supervisor skipped — __runSupervisor=false', {
      executionId: ctx.executionId,
      stepId: step.id,
    });
    return {
      output: { skipped: true, reason: 'supervisor disabled at trigger time' },
      tokensUsed: 0,
      costUsd: 0,
      skipped: true,
      expectedSkip: true,
    };
  }

  const minWeaknesses = config.minWeaknesses ?? 1;
  const requireEvidenceCitations = config.requireEvidenceCitations ?? true;
  const useJudgeModel = config.useJudgeModel ?? true;
  const includeMode = config.includeStepOutputs ?? 'auto';
  const temperature = config.temperature ?? 0.2;
  const failOnVerdict = config.failOnVerdict ?? 'never';
  const modelOverride =
    config.modelOverride && config.modelOverride.length > 0
      ? config.modelOverride
      : useJudgeModel
        ? JUDGE_MODEL
        : undefined;

  const { projection } = buildProjection(ctx, includeMode);

  // outputData isn't on the context — it's only set on finalize. The
  // supervisor sees `null` for now; we project the most recent step's
  // output as the implicit final answer when needed.
  const prompt = buildPrompt({
    assessmentCriteria: config.assessmentCriteria,
    redTeamPrompts: config.redTeamPrompts ?? DEFAULT_RED_TEAM_PROMPTS,
    minWeaknesses,
    projection,
    inputData: ctx.inputData,
    outputData: null,
    workflowId: ctx.workflowId,
    executionId: ctx.executionId,
  });

  let totalTokens = 0;
  let totalCost = 0;

  const callOnce = async (
    attemptTemperature: number
  ): Promise<{ content: string; tokensUsed: number; costUsd: number; model: string }> => {
    const result = await runLlmCall(ctx, {
      stepId: step.id,
      prompt,
      modelOverride,
      temperature: attemptTemperature,
    });
    totalTokens += result.tokensUsed;
    totalCost += result.costUsd;
    return result;
  };

  let parsed: ParsedReport | null = null;
  let rawForFailure = '';
  try {
    const first = await callOnce(temperature);
    rawForFailure = first.content;
    parsed = tryParse(first.content);
    if (!parsed) {
      logger.warn('supervisor: first attempt malformed, retrying at temp=0', {
        executionId: ctx.executionId,
        stepId: step.id,
      });
      const retry = await callOnce(0);
      rawForFailure = retry.content;
      parsed = tryParse(retry.content);
    }
  } catch (err) {
    // LLM call itself failed (provider error / timeout / abort). Re-raise
    // so the engine's errorStrategy machinery applies.
    throw err instanceof ExecutorError
      ? err
      : new ExecutorError(
          step.id,
          'supervisor_llm_failed',
          err instanceof Error ? err.message : 'supervisor LLM call failed',
          err
        );
  }

  // Twice-malformed → 'inconclusive' verdict. Don't throw; the operator
  // needs the signal that the audit ran but couldn't be parsed.
  if (!parsed) {
    const report: SupervisorReport = {
      verdict: 'inconclusive',
      score: 0,
      summary:
        'Supervisor could not be parsed. Two attempts produced malformed JSON. See parseFailure for the raw response.',
      strengths: [],
      weaknesses: [],
      anomalies: [],
      unverifiedAreas: ['entire trace — supervisor output unparseable'],
      confidence: 'low',
      parseFailure: {
        rawResponse: rawForFailure.slice(0, 8000),
        reason: 'JSON did not satisfy reportShapeSchema after retry',
      },
      triggeredBy: 'in_workflow',
    };
    return {
      output: report,
      tokensUsed: totalTokens,
      costUsd: totalCost,
      contextPatch: buildVerdictContextPatch(report),
    };
  }

  const { validatedReport } = validateCitations(
    parsed,
    ctx.stepOutputs,
    minWeaknesses,
    requireEvidenceCitations
  );

  const finalReport: SupervisorReport = { ...validatedReport, triggeredBy: 'in_workflow' };

  // failOnVerdict=fail throws ExecutorError; engine's errorStrategy decides
  // (default 'fail' terminates workflow, 'skip' continues, 'fallback' routes).
  if (failOnVerdict === 'fail' && finalReport.verdict === 'fail') {
    throw new ExecutorError(
      step.id,
      'supervisor_verdict_fail',
      `Supervisor verdict is 'fail': ${finalReport.summary.slice(0, 200)}`
    );
  }

  return {
    output: finalReport,
    tokensUsed: totalTokens,
    costUsd: totalCost,
    contextPatch: buildVerdictContextPatch(finalReport),
  };
}

/**
 * Build the column-patch object lifted into the next checkpoint /
 * finalize write. Kept here (not in the engine) so the engine doesn't
 * grow knowledge of supervisor semantics — the engine's allowlist is
 * the gate; the executor decides what to publish.
 */
function buildVerdictContextPatch(report: SupervisorReport): Record<string, unknown> {
  return {
    supervisorVerdict: report.verdict,
    supervisorScore: report.score,
    supervisorReport: report as unknown as Record<string, unknown>,
    supervisorReviewedAt: new Date(),
  };
}

registerStepType('supervisor', executeSupervisor);

// ─── Testing-only exports ───────────────────────────────────────────────────
// These are exported so unit tests can exercise pure helpers without going
// through the LLM call. Not part of any public API.
export const __test__ = {
  buildProjection,
  buildPrompt,
  sampleString,
  serialiseStepOutput,
  validateCitations,
  tryParse,
  reportShapeSchema,
};
