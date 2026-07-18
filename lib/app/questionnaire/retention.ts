/**
 * App-layer retention pruning (F14.15).
 *
 * ## Why this exists
 *
 * `lib/orchestration/retention.ts` prunes exactly ten platform models and touches **no** `App*`
 * model. That was fine while the app stored only artifacts, but the evaluation and provenance work
 * added high-volume, unbounded tables:
 *
 * - `AppQuestionnaireTurnEvaluation` — one row per evaluated turn, each carrying a full `verdict`
 *   AND an `evaluatedInput` snapshot. The highest-volume evaluation table in the app, and it grew
 *   forever; rows were removed only by session cascade or GDPR erasure.
 * - `AppQuestionnaireEvaluationRun` / `…Finding` — design-eval runs, each with a
 *   `structureSnapshot`.
 * - `AppAiRun` — one row per captured authoring/report run, with prompt + output snapshots.
 *
 * This lives in `lib/app/**` rather than as an edit to the platform retention module, per the
 * app/platform split in CUSTOMIZATION.md: the platform file merges from upstream on every sync, so
 * app-owned prunes belong in app-owned files.
 *
 * ## Windows
 *
 * All three reuse the platform's `evaluationRetentionDays` setting — they are the same class of
 * data (evaluation/provenance history whose subject outlives it), and giving the operator a fourth
 * knob to keep coherent with the other three would invite exactly the drift the platform module
 * already warns about. `null` (the default) means "keep forever", matching every other prune.
 *
 * ## Safety
 *
 * Prunes are age-based on `createdAt` and unconditional — unlike executions and eval runs, none of
 * these models has an in-flight state to protect. A turn evaluation is written once, complete, and
 * never transitions.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/** Per-model counts from one app retention sweep. */
export interface AppRetentionResult {
  turnEvaluationsDeleted: number;
  evaluationRunsDeleted: number;
  aiRunsDeleted: number;
  /** The resolved window in days, or null when pruning is disabled. */
  retentionDays: number | null;
}

const EMPTY: AppRetentionResult = {
  turnEvaluationsDeleted: 0,
  evaluationRunsDeleted: 0,
  aiRunsDeleted: 0,
  retentionDays: null,
};

/**
 * Prune aged app evaluation + provenance rows.
 *
 * Returns zero counts (and does nothing) when `evaluationRetentionDays` is unset. Never throws —
 * a maintenance task that fails must not take the rest of the tick's chain down with it.
 */
export async function enforceAppRetentionPolicies(): Promise<AppRetentionResult> {
  try {
    const days = await resolveEvaluationRetentionDays();
    if (days === null || days <= 0) return EMPTY;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Findings cascade from their run, so deleting the run is sufficient.
    const [turnEvaluations, evaluationRuns, aiRuns] = await Promise.all([
      prisma.appQuestionnaireTurnEvaluation.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      prisma.appQuestionnaireEvaluationRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      prisma.appAiRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ]);

    const result: AppRetentionResult = {
      turnEvaluationsDeleted: turnEvaluations.count,
      evaluationRunsDeleted: evaluationRuns.count,
      aiRunsDeleted: aiRuns.count,
      retentionDays: days,
    };

    const total =
      result.turnEvaluationsDeleted + result.evaluationRunsDeleted + result.aiRunsDeleted;
    if (total > 0) {
      logger.info('App retention sweep pruned aged evaluation/provenance rows', { ...result });
    }
    return result;
  } catch (err) {
    logger.error('App retention sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  }
}

/**
 * Read the platform's `evaluationRetentionDays`. Returns null (⇒ keep forever) when the settings
 * row is missing or unreadable, so a settings outage can never cause an over-aggressive delete.
 */
async function resolveEvaluationRetentionDays(): Promise<number | null> {
  try {
    const row = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { evaluationRetentionDays: true },
    });
    return row?.evaluationRetentionDays ?? null;
  } catch {
    return null;
  }
}
