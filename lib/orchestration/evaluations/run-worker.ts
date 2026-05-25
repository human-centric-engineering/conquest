/**
 * Batch evaluation run worker.
 *
 * Called once per maintenance-tick from
 * `app/api/v1/admin/orchestration/maintenance/tick/route.ts` in the
 * background `void Promise.allSettled` chain (NEVER awaited on the HTTP
 * path — long batches must not stall the tick endpoint).
 *
 * Lifecycle per invocation:
 *
 *   1. Try to claim ONE queued or orphan-stale run (`claimNextRun`).
 *      If nothing is claimable, return immediately.
 *   2. Validate the dataset content hash; mismatch ⇒ mark failed
 *      with `summary.note = 'dataset_changed_post_submit'`.
 *   3. Pre-flight the run's grader configs against the dataset (all
 *      reference-required graders need `expectedOutput`).
 *   4. Resolve the judge model once and reuse across cases.
 *   5. Time-budgeted loop (≤ WORKER_TIME_BUDGET_MS, default ~45s):
 *      for each case lacking a result row, drain the subject, grade
 *      with every configured metric, write the result row, update
 *      progress. If the budget expires mid-run, release the lease so
 *      the next tick resumes from the next unprocessed case.
 *   6. When every case has a result: compute aggregate summary,
 *      log the run-level cost rollup, mark `status='completed'`.
 *
 * Concurrency-safe: the worker is single-tick-scoped and the claim
 * step ensures only one worker can hold a run's lease at a time.
 * Orphan recovery happens via the same claim function on the next
 * tick — a crashed worker's run resumes from the case-cursor without
 * special handling.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import {
  EVALUATION_DEFAULT_MODEL,
  EVALUATION_DEFAULT_PROVIDER,
  JUDGE_MODEL,
  JUDGE_PROVIDER,
} from '@/lib/orchestration/evaluations/judge-model';
import {
  type ClaimedRun,
  claimNextRun,
  markTerminal,
  releaseLease,
} from '@/lib/orchestration/evaluations/run-claim';
import { hashDatasetCases } from '@/lib/orchestration/evaluations/datasets/hash';
import { runAgentCase } from '@/lib/orchestration/evaluations/run-cases/agent-case';
import { runWorkflowCase } from '@/lib/orchestration/evaluations/run-cases/workflow-case';
import {
  getGrader,
  type GraderInput,
  type JudgeBinding,
} from '@/lib/orchestration/evaluations/graders';
// Side-effect import: registers every built-in grader at module load.
import '@/lib/orchestration/evaluations/graders';

/** Soft time budget for one worker tick (~45s, leaves headroom in a 60s cron). */
const WORKER_TIME_BUDGET_MS = 45 * 1000;
/**
 * Throttle progress writes — one per N cases. Hot writes per-case
 * would multiply DB load for negligible UX gain in a polling UI.
 */
const PROGRESS_WRITE_EVERY = 5;

interface MetricConfigEntry {
  slug: string;
  config: unknown;
}

interface CaseResultRowInput {
  runId: string;
  datasetCaseId: string;
  casePosition: number;
  subjectOutput: string;
  subjectMetadata: Record<string, unknown> | null;
  metricScores: Record<string, unknown>;
  latencyMs: number;
  costUsd: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Entry point invoked by the maintenance tick. Returns a small summary
 * the tick logger uses to surface per-task outcomes.
 */
export async function processPendingEvaluationRuns(): Promise<{
  claimed: number;
  completed: number;
  released: number;
  failed: number;
}> {
  const workerId = `worker-${process.pid}-${Date.now()}`;
  const claimed = await claimNextRun(workerId);
  if (!claimed) {
    return { claimed: 0, completed: 0, released: 0, failed: 0 };
  }

  try {
    const outcome = await driveRun(claimed);
    return {
      claimed: 1,
      completed: outcome === 'completed' ? 1 : 0,
      released: outcome === 'released' ? 1 : 0,
      failed: outcome === 'failed' ? 1 : 0,
    };
  } catch (err) {
    logger.error('Evaluation run worker crashed; marking run failed', {
      runId: claimed.id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await markTerminal(claimed.id, 'failed', {
        summary: { error: 'worker_unexpected_error', message: String(err) },
      });
    } catch (markErr) {
      logger.error('Failed to mark crashed evaluation run terminal', {
        runId: claimed.id,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
    return { claimed: 1, completed: 0, released: 0, failed: 1 };
  }
}

// ---------------------------------------------------------------------------
// Per-run pipeline
// ---------------------------------------------------------------------------

type RunOutcome = 'completed' | 'released' | 'failed';

async function driveRun(run: ClaimedRun): Promise<RunOutcome> {
  // 1. Hash-pin check
  const cases = await prisma.aiDatasetCase.findMany({
    where: { datasetId: run.datasetId },
    orderBy: { position: 'asc' },
  });
  const currentHash = hashDatasetCases(
    cases.map((c) => ({
      position: c.position,
      input: c.input as unknown,
      expectedOutput: c.expectedOutput ?? null,
      metadata: c.metadata as unknown,
      referenceCitations: c.referenceCitations as unknown,
    }))
  );
  if (currentHash !== run.datasetContentHash) {
    await markTerminal(run.id, 'failed', {
      summary: {
        note: 'dataset_changed_post_submit',
        expectedHash: run.datasetContentHash,
        currentHash,
      },
    });
    return 'failed';
  }

  // 2. Parse and pre-flight metric configs
  const metricConfigs = parseMetricConfigs(run.metricConfigs);
  if (metricConfigs === null) {
    await markTerminal(run.id, 'failed', {
      summary: { note: 'invalid_metric_configs' },
    });
    return 'failed';
  }
  const preflightError = preflightMetrics(metricConfigs, cases);
  if (preflightError) {
    await markTerminal(run.id, 'failed', {
      summary: { note: 'preflight_failed', error: preflightError },
    });
    return 'failed';
  }

  // 3. Resolve agent slug + judge binding (once per run)
  if (run.subjectKind !== 'agent' && run.subjectKind !== 'workflow') {
    await markTerminal(run.id, 'failed', {
      summary: { note: 'unknown_subject_kind', subjectKind: run.subjectKind },
    });
    return 'failed';
  }
  let agentSlug: string | null = null;
  if (run.subjectKind === 'agent') {
    if (!run.agentId) {
      await markTerminal(run.id, 'failed', {
        summary: { note: 'agent_missing_for_agent_subject' },
      });
      return 'failed';
    }
    const agent = await prisma.aiAgent.findUnique({
      where: { id: run.agentId },
      select: { slug: true },
    });
    if (!agent) {
      await markTerminal(run.id, 'failed', {
        summary: { note: 'agent_deleted', agentId: run.agentId },
      });
      return 'failed';
    }
    agentSlug = agent.slug;
  }

  const judge = await resolveJudgeBinding(run);

  // 4. Find which case positions still need processing
  const existing = await prisma.aiEvaluationCaseResult.findMany({
    where: { runId: run.id },
    select: { casePosition: true },
  });
  const done = new Set(existing.map((r) => r.casePosition));
  const pending = cases.filter((c) => !done.has(c.position));

  // 5. Time-budgeted loop
  const tickStart = Date.now();
  let processedThisTick = 0;
  let releasedEarly = false;
  for (const caseRow of pending) {
    if (Date.now() - tickStart > WORKER_TIME_BUDGET_MS) {
      releasedEarly = true;
      break;
    }

    const result = await processOneCase({
      run,
      agentSlug,
      caseRow,
      metricConfigs,
      judge,
    });
    await prisma.aiEvaluationCaseResult.create({
      data: {
        runId: run.id,
        datasetCaseId: result.datasetCaseId,
        casePosition: result.casePosition,
        subjectOutput: result.subjectOutput,
        subjectMetadata: result.subjectMetadata as never,
        metricScores: result.metricScores as never,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
      },
    });
    processedThisTick++;
    if (processedThisTick % PROGRESS_WRITE_EVERY === 0) {
      await writeProgress(run.id, cases.length);
    }
  }

  if (releasedEarly) {
    await writeProgress(run.id, cases.length);
    await releaseLease(run.id);
    return 'released';
  }

  // 6. Final aggregation
  await writeProgress(run.id, cases.length);
  const allResults = await prisma.aiEvaluationCaseResult.findMany({
    where: { runId: run.id },
  });
  const summary = aggregateSummary(allResults, metricConfigs, judge);
  const totalCost = allResults.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  await markTerminal(run.id, 'completed', { summary, totalCostUsd: totalCost });

  // Run-level cost rollup — one row per terminal run
  void logCost({
    operation: CostOperation.EVALUATION_BATCH,
    model: judge.model,
    provider: judge.providerSlug,
    inputTokens: summary.totalJudgeTokens.input,
    outputTokens: summary.totalJudgeTokens.output,
    metadata: { evaluationRunId: run.id, phase: 'rollup' },
    ...(run.agentId ? { agentId: run.agentId } : {}),
  }).catch((err) => {
    logger.error('Failed to log evaluation run rollup cost', {
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return 'completed';
}

// ---------------------------------------------------------------------------
// Per-case
// ---------------------------------------------------------------------------

interface ProcessCaseArgs {
  run: ClaimedRun;
  agentSlug: string | null;
  caseRow: {
    id: string;
    position: number;
    input: unknown;
    expectedOutput: string | null;
    referenceCitations: unknown;
    metadata: unknown;
  };
  metricConfigs: MetricConfigEntry[];
  judge: JudgeBinding;
}

async function processOneCase(args: ProcessCaseArgs): Promise<CaseResultRowInput> {
  const { run, agentSlug, caseRow, metricConfigs, judge } = args;
  // Subject dispatch ----------------------------------------------------------
  let subjectOutput = '';
  let subjectCostUsd = 0;
  let subjectLatency = 0;
  let citations: GraderInput['citations'] = [];
  let toolCalls: GraderInput['toolCalls'] = [];
  let subjectErrorCode: string | undefined;
  let subjectErrorMessage: string | undefined;

  if (run.subjectKind === 'agent') {
    if (!agentSlug) {
      subjectErrorCode = 'agent_slug_unresolved';
    } else {
      const result = await runAgentCase({
        agentSlug,
        userId: run.userId,
        message: typeof caseRow.input === 'string' ? caseRow.input : JSON.stringify(caseRow.input),
      });
      subjectOutput = result.assistantText;
      subjectCostUsd = result.costUsd;
      subjectLatency = result.latencyMs;
      citations = result.citations;
      toolCalls = result.toolCalls.map((t) => ({
        slug: t.slug,
        args:
          t.arguments && typeof t.arguments === 'object' && !Array.isArray(t.arguments)
            ? (t.arguments as Record<string, unknown>)
            : undefined,
      }));
      if (result.errorCode) {
        subjectErrorCode = result.errorCode;
        subjectErrorMessage = result.errorMessage;
      }
    }
  } else {
    // Phase 1: workflow case returns a typed not-supported error.
    const result = await runWorkflowCase({
      workflowId: run.workflowId ?? '',
      userId: run.userId,
      input:
        caseRow.input && typeof caseRow.input === 'object' && !Array.isArray(caseRow.input)
          ? (caseRow.input as Record<string, unknown>)
          : { input: caseRow.input },
      subjectOutputSelector: run.subjectOutputSelector,
    });
    subjectOutput = result.assistantText;
    subjectCostUsd = result.costUsd;
    subjectLatency = result.latencyMs;
    citations = result.citations;
    if (result.errorCode) {
      subjectErrorCode = result.errorCode;
      subjectErrorMessage = result.errorMessage;
    }
  }

  // Grader dispatch -----------------------------------------------------------
  const metricScores: Record<string, unknown> = {};
  let graderCost = 0;
  let graderInputTokens = 0;
  let graderOutputTokens = 0;
  for (const entry of metricConfigs) {
    // Subject error => skip graders, record null score with a reason
    if (subjectErrorCode) {
      metricScores[entry.slug] = {
        score: null,
        reasoning: `Skipped: subject execution failed (${subjectErrorCode}).`,
      };
      continue;
    }
    const grader = getGrader(entry.slug);
    const parsed = grader.configSchema.safeParse(entry.config ?? grader.defaultConfig ?? {});
    if (!parsed.success) {
      metricScores[entry.slug] = {
        score: null,
        reasoning: `Skipped: invalid config — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
      continue;
    }
    try {
      const r = await grader.grade({
        userInput:
          typeof caseRow.input === 'string' ? caseRow.input : JSON.stringify(caseRow.input),
        modelOutput: subjectOutput,
        ...(caseRow.expectedOutput ? { expectedOutput: caseRow.expectedOutput } : {}),
        citations,
        toolCalls,
        judge: grader.family === 'model' ? judge : undefined,
        config: parsed.data,
      });
      metricScores[entry.slug] = {
        score: r.score,
        passed: r.passed,
        reasoning: r.reasoning,
        costUsd: r.costUsd,
      };
      if (r.costUsd) graderCost += r.costUsd;
      if (r.tokenUsage) {
        graderInputTokens += r.tokenUsage.input;
        graderOutputTokens += r.tokenUsage.output;
      }
    } catch (err) {
      metricScores[entry.slug] = {
        score: null,
        reasoning: `Grader threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Cost logging policy:
  //   - SUBJECT cost is NOT logged here. `streamChat()` already writes a
  //     `CostOperation.CHAT` row per LLM turn for the agent subject; double-
  //     logging would distort analytics.
  //   - JUDGE cost is net-new (no other code path writes it), so log it once
  //     per case under EVALUATION_JUDGE with `metadata.evaluationRunId`.
  if (graderCost > 0) {
    void logCost({
      operation: CostOperation.EVALUATION_JUDGE,
      model: judge.model,
      provider: judge.providerSlug,
      inputTokens: graderInputTokens,
      outputTokens: graderOutputTokens,
      metadata: { evaluationRunId: run.id, phase: 'judge', casePosition: caseRow.position },
      ...(run.agentId ? { agentId: run.agentId } : {}),
    }).catch(() => {});
  }

  const out: CaseResultRowInput = {
    runId: run.id,
    datasetCaseId: caseRow.id,
    casePosition: caseRow.position,
    subjectOutput,
    subjectMetadata: {
      citations,
      toolCalls,
      subjectCostUsd,
      subjectLatencyMs: subjectLatency,
    },
    metricScores,
    latencyMs: subjectLatency,
    costUsd: subjectCostUsd + graderCost,
  };
  if (subjectErrorCode) out.errorCode = subjectErrorCode;
  if (subjectErrorMessage) out.errorMessage = subjectErrorMessage;
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface RunSummary {
  metricSlugs: string[];
  stats: Record<
    string,
    {
      mean: number | null;
      median: number | null;
      p95: number | null;
      passRate: number | null;
      scoredCount: number;
    }
  >;
  judgeProvider: string;
  judgeModel: string;
  completedAt: string;
  totalJudgeTokens: { input: number; output: number };
  note?: string;
}

function aggregateSummary(
  results: Array<{
    metricScores: unknown;
    subjectMetadata: unknown;
  }>,
  metricConfigs: MetricConfigEntry[],
  judge: JudgeBinding
): RunSummary {
  const stats: RunSummary['stats'] = {};
  let totalIn = 0;
  let totalOut = 0;
  for (const entry of metricConfigs) {
    const scores: number[] = [];
    const passed: boolean[] = [];
    for (const r of results) {
      const ms = (r.metricScores as Record<string, unknown> | null) ?? {};
      const cell = ms[entry.slug] as
        | { score?: unknown; passed?: unknown; tokenUsage?: { input?: number; output?: number } }
        | undefined;
      if (!cell) continue;
      if (typeof cell.score === 'number') scores.push(cell.score);
      if (typeof cell.passed === 'boolean') passed.push(cell.passed);
      if (cell.tokenUsage) {
        totalIn += cell.tokenUsage.input ?? 0;
        totalOut += cell.tokenUsage.output ?? 0;
      }
    }
    stats[entry.slug] = {
      mean: mean(scores),
      median: percentile(scores, 0.5),
      p95: percentile(scores, 0.95),
      passRate: passed.length > 0 ? passed.filter(Boolean).length / passed.length : null,
      scoredCount: scores.length,
    };
  }
  return {
    metricSlugs: metricConfigs.map((m) => m.slug),
    stats,
    judgeProvider: judge.providerSlug,
    judgeModel: judge.model,
    completedAt: new Date().toISOString(),
    totalJudgeTokens: { input: totalIn, output: totalOut },
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMetricConfigs(raw: unknown): MetricConfigEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MetricConfigEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.slug !== 'string') return null;
    out.push({ slug: obj.slug, config: obj.config });
  }
  return out;
}

function preflightMetrics(
  configs: MetricConfigEntry[],
  cases: Array<{ expectedOutput: string | null }>
): string | null {
  for (const entry of configs) {
    let grader;
    try {
      grader = getGrader(entry.slug);
    } catch {
      return `unknown grader "${entry.slug}"`;
    }
    if (grader.referenceRequired) {
      const missing = cases.filter((c) => !c.expectedOutput).length;
      if (missing > 0) {
        return `${missing} case(s) without expectedOutput, required by "${entry.slug}"`;
      }
    }
  }
  return null;
}

async function resolveJudgeBinding(run: ClaimedRun): Promise<JudgeBinding> {
  let providerSlug: string;
  let model: string;
  if (run.judgeProvider && run.judgeModel) {
    providerSlug = run.judgeProvider;
    model = run.judgeModel;
  } else if (JUDGE_PROVIDER !== null && JUDGE_MODEL !== null) {
    providerSlug = JUDGE_PROVIDER;
    model = JUDGE_MODEL;
  } else if (EVALUATION_DEFAULT_PROVIDER !== null && EVALUATION_DEFAULT_MODEL !== null) {
    providerSlug = EVALUATION_DEFAULT_PROVIDER;
    model = EVALUATION_DEFAULT_MODEL;
  } else {
    const resolved = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  }
  const provider = await getProvider(providerSlug);
  return { provider, providerSlug, model };
}

async function writeProgress(runId: string, casesTotal: number): Promise<void> {
  const done = await prisma.aiEvaluationCaseResult.count({ where: { runId } });
  const failed = await prisma.aiEvaluationCaseResult.count({
    where: { runId, errorCode: { not: null } },
  });
  await prisma.aiEvaluationRun.update({
    where: { id: runId },
    data: {
      progress: { casesTotal, casesDone: done, casesFailed: failed },
    },
  });
}
