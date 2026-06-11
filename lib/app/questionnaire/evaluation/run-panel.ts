/**
 * Shared judge-panel dispatch (F5.1 seam, extracted at F5.2).
 *
 * The single place that fans the seven design-evaluation judges out concurrently and
 * reduces their outcomes to a `{ results, summary }` shape. Two callers share it:
 *
 *   - the F5.1 preview route (`evaluate-preview`) — runs the panel and returns the
 *     result ephemerally (persists nothing),
 *   - the F5.2 run route (`evaluations`) — runs the panel, then persists the run + its
 *     findings.
 *
 * DB-free: the loaded judge agents and the version structure are passed in, so this
 * stays in the pure `lib/app/**` layer (no Prisma, no Next.js) — persistence and the
 * agent/structure loads are the route's concern, the same seam split as
 * `buildEvaluationStructure`. Per-judge failure is fail-soft: a missing agent or a
 * failed/throwing dispatch degrades to a `diagnostic` for that one dimension while the
 * others still return, so one flaky judge can never sink the whole panel.
 */

import type { Logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { EVALUATE_STRUCTURE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { EvaluateStructureData } from '@/lib/app/questionnaire/capabilities';
import {
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
  type JudgeVerdict,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';

/** One dimension's outcome: a verdict, or a diagnostic when its judge failed/was absent. */
export interface DimensionResult {
  dimension: EvaluationDimension;
  verdict?: JudgeVerdict;
  diagnostic?: string;
}

/** Aggregate tallies over the dispatched panel. */
export interface EvaluationPanelSummary {
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
}

/** The panel result: one entry per requested dimension, plus the summary tallies. */
export interface EvaluationPanelResult {
  results: DimensionResult[];
  summary: EvaluationPanelSummary;
}

/**
 * The slice of a loaded `kind='judge'` agent the dispatch needs — the provider-agnostic
 * binding the `evaluate-structure` capability resolves from the dispatch context. Mirrors
 * the `select` the routes run against `prisma.aiAgent`.
 */
export interface JudgeAgentRef {
  slug: string;
  id: string;
  provider: string | null;
  model: string | null;
  fallbackProviders: unknown;
}

/**
 * Dispatch the requested judge dimensions concurrently and reduce to `{ results, summary }`.
 *
 * @param dimensions      The (already deduped) dimensions to run.
 * @param structure       The version's authored structure DTO (from `buildEvaluationStructure`).
 * @param questionnaireId Parent questionnaire id — log context only, so per-judge failures
 *                        stay correlatable to a questionnaire (the inline route had this).
 * @param versionId       For cost-tracking metadata on the dispatch + log context.
 * @param agentBySlug     Loaded judge agents keyed by slug (from the route's `aiAgent` query).
 * @param adminId         The admin who owns the run/spend — passed as the dispatch `userId`.
 * @param log             Route-scoped logger; per-judge failures are warned/errored here.
 */
export async function runEvaluationPanel(args: {
  dimensions: EvaluationDimension[];
  structure: VersionStructureInput;
  questionnaireId: string;
  versionId: string;
  agentBySlug: Map<string, JudgeAgentRef>;
  adminId: string;
  log: Logger;
}): Promise<EvaluationPanelResult> {
  const { dimensions, structure, questionnaireId, versionId, agentBySlug, adminId, log } = args;

  // Flush capability handlers before the fan-out — this panel may be the first capability touch
  // on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot; registering
  // once here keeps it off the per-dimension hot path below.
  registerBuiltInCapabilities();

  // Dispatch the panel concurrently. Per-judge failure is fail-soft: a missing agent or a
  // failed call yields a `diagnostic` for that dimension, never a thrown error, so one
  // flaky judge can't sink the other six.
  const results: DimensionResult[] = await Promise.all(
    dimensions.map(async (dimension): Promise<DimensionResult> => {
      const agent = agentBySlug.get(EVALUATION_DIMENSION_SPECS[dimension].slug);
      if (!agent) {
        log.warn('Judge agent missing for dimension; skipping', {
          questionnaireId,
          versionId,
          dimension,
        });
        return { dimension, diagnostic: 'judge_not_configured' };
      }

      // The dispatcher represents capability failures as a `{ success: false }` envelope,
      // but it can still THROW on an infrastructure fault (e.g. the registry DB load inside
      // `dispatch` failing) — and because the panel fans out under one `Promise.all`, an
      // unguarded throw would reject the whole request. Wrap the dispatch so any throw
      // degrades to this dimension's diagnostic, keeping the fail-soft contract literally
      // true even for unexpected faults.
      let dispatch;
      try {
        dispatch = await capabilityDispatcher.dispatch(
          EVALUATE_STRUCTURE_CAPABILITY_SLUG,
          { dimension, structure, versionId },
          {
            userId: adminId,
            agentId: agent.id,
            entityContext: {
              judgeAgent: {
                provider: agent.provider,
                model: agent.model,
                fallbackProviders: agent.fallbackProviders,
              },
            },
          }
        );
      } catch (err) {
        log.error('Judge dispatch threw; returning diagnostic for dimension', {
          questionnaireId,
          versionId,
          dimension,
          error: err instanceof Error ? err.message : String(err),
        });
        return { dimension, diagnostic: 'dispatch_error' };
      }

      if (dispatch.success && dispatch.data) {
        return { dimension, verdict: (dispatch.data as EvaluateStructureData).verdict };
      }
      log.warn('Judge dispatch failed; returning diagnostic for dimension', {
        questionnaireId,
        versionId,
        dimension,
        code: dispatch.error?.code,
      });
      return { dimension, diagnostic: dispatch.error?.code ?? 'evaluation_failed' };
    })
  );

  const dimensionsRun = results.filter((r) => r.verdict !== undefined).length;
  const totalFindings = results.reduce((sum, r) => sum + (r.verdict?.findings.length ?? 0), 0);

  return {
    results,
    summary: {
      dimensionsRequested: dimensions.length,
      dimensionsRun,
      dimensionsFailed: dimensions.length - dimensionsRun,
      totalFindings,
    },
  };
}
