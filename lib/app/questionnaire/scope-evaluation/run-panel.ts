/**
 * Scope-evaluation judge-panel dispatch (F17.21).
 *
 * The single place that fans the four scope-evaluation judges out concurrently and reduces their
 * outcomes to a `{ results, summary }` shape — the `run-panel.ts` pattern from `evaluation/**`,
 * without the cross-judge reconciliation step: the four scope dimensions target different fields of
 * different objects (topic criteria text, the rules array, the settings blob), so the collision case
 * the design-evaluation reconciler exists for — two judges independently rewriting the same
 * question's prompt — mostly cannot occur here. A deliberate v1 cut, not an oversight; add one later
 * if real overlap shows up.
 *
 * DB-free: the loaded judge agents and the scope structure are passed in, so this stays in the pure
 * `lib/app/**` layer. Per-judge failure is fail-soft: a missing agent or a failed/throwing dispatch
 * degrades to a `diagnostic` for that one dimension while the others still return.
 */

import type { Logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { EVALUATE_SCOPE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { EvaluateScopeData } from '@/lib/app/questionnaire/capabilities';
import {
  SCOPE_EVALUATION_DIMENSION_SPECS,
  type ScopeDimensionSpec,
} from '@/lib/app/questionnaire/scope-evaluation/dimensions';
import type {
  ScopeEvaluationDimension,
  ScopeJudgeVerdict,
  ScopeStructureInput,
} from '@/lib/app/questionnaire/scope-evaluation/types';

/** One dimension's outcome: a verdict, or a diagnostic when its judge failed/was absent. */
export interface ScopeDimensionResult {
  dimension: ScopeEvaluationDimension;
  verdict?: ScopeJudgeVerdict;
  diagnostic?: string;
}

/** Aggregate tallies over the dispatched panel. */
export interface ScopeEvaluationPanelSummary {
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
}

/** The panel result: one entry per requested dimension, plus the summary tallies. */
export interface ScopeEvaluationPanelResult {
  results: ScopeDimensionResult[];
  summary: ScopeEvaluationPanelSummary;
}

/**
 * The slice of a loaded `kind='judge'` agent the dispatch needs — mirrors `JudgeAgentRef` in
 * `evaluation/run-panel.ts`.
 */
export interface ScopeJudgeAgentRef {
  slug: string;
  id: string;
  provider: string | null;
  model: string | null;
  fallbackProviders: unknown;
}

/** Read one dimension's spec — kept as a helper so a future dimension needs no call-site change. */
function specFor(dimension: ScopeEvaluationDimension): ScopeDimensionSpec {
  return SCOPE_EVALUATION_DIMENSION_SPECS[dimension];
}

/**
 * Dispatch the requested scope-evaluation dimensions concurrently and reduce to
 * `{ results, summary }`. Mirrors `runEvaluationPanel`, minus the reconcile step (see module doc).
 *
 * @param dimensions      The (already deduped) dimensions to run.
 * @param structure       The version's authored scope-config DTO (from `buildScopeEvaluationStructure`).
 * @param questionnaireId Parent questionnaire id — log context only.
 * @param versionId       For cost-tracking metadata on the dispatch + log context.
 * @param agentBySlug     Loaded judge agents keyed by slug (from the route's `aiAgent` query).
 * @param adminId         The admin who owns the run/spend — passed as the dispatch `userId`.
 * @param log             Route-scoped logger; per-judge failures are warned/errored here.
 */
export async function runScopeEvaluationPanel(args: {
  dimensions: ScopeEvaluationDimension[];
  structure: ScopeStructureInput;
  questionnaireId: string;
  versionId: string;
  agentBySlug: Map<string, ScopeJudgeAgentRef>;
  adminId: string;
  log: Logger;
}): Promise<ScopeEvaluationPanelResult> {
  const { dimensions, structure, questionnaireId, versionId, agentBySlug, adminId, log } = args;

  // Flush capability handlers before the fan-out — idempotent, one-shot; registering once here
  // keeps it off the per-dimension hot path below.
  registerBuiltInCapabilities();

  const results: ScopeDimensionResult[] = await Promise.all(
    dimensions.map(async (dimension): Promise<ScopeDimensionResult> => {
      const agent = agentBySlug.get(specFor(dimension).slug);
      if (!agent) {
        log.warn('Scope judge agent missing for dimension; skipping', {
          questionnaireId,
          versionId,
          dimension,
        });
        return { dimension, diagnostic: 'judge_not_configured' };
      }

      // The dispatcher represents capability failures as a `{ success: false }` envelope, but can
      // still THROW on an infrastructure fault — wrapped so any throw degrades to this dimension's
      // diagnostic rather than rejecting the whole `Promise.all`.
      let dispatch;
      try {
        dispatch = await capabilityDispatcher.dispatch(
          EVALUATE_SCOPE_CAPABILITY_SLUG,
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
        log.error('Scope judge dispatch threw; returning diagnostic for dimension', {
          questionnaireId,
          versionId,
          dimension,
          error: err instanceof Error ? err.message : String(err),
        });
        return { dimension, diagnostic: 'dispatch_error' };
      }

      if (dispatch.success && dispatch.data) {
        return { dimension, verdict: (dispatch.data as EvaluateScopeData).verdict };
      }
      log.warn('Scope judge dispatch failed; returning diagnostic for dimension', {
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
