/**
 * Interviewer-policy judge-panel dispatch (F18.8).
 *
 * Fans the four judges out concurrently and reduces their outcomes to `{ results, summary }` — the
 * `run-panel.ts` pattern both sibling panels use.
 *
 * **No cross-judge reconciliation step — but NOT for the scope panel's reason, and the difference
 * matters enough to write down.** The scope panel argued that its four dimensions target different
 * fields of different objects, so a collision mostly cannot occur. That argument does **not** hold
 * here: `cross_layer_conflict` can propose an edit to the same house rule as `rule_coherence`, the
 * same strategy field as `arc_fit`, and the same question as `fidelity_calibration`.
 *
 * There is still no reconciler, on three different grounds:
 *
 * 1. **The overlapping fields are enums and numbers, not prose.** The design-evaluation reconciler
 *    exists because two judges rewrite one question's *prompt* with two incompatible paragraphs, and
 *    a reviewer cannot diff two paragraphs at a glance. `funnel` against `targeted`, side by side on
 *    one card, is legible in a second.
 * 2. **Grouping already does the reconciler's presentation job** — `groupPolicyFindingsByTarget`
 *    puts both findings under one target with both rationales visible.
 * 3. **Per-op staleness already does its safety job.** Once one applies, the other's apply 409s
 *    rather than silently overwriting it.
 *
 * Two things are load-bearing as a consequence, and both are the apply engine's contract rather than
 * this file's: the apply route must resolve the run's existing review draft *before* building the
 * comparison state, and staleness must compare only the op's own field. See the module doc in
 * `_lib/policy-evaluation-apply.ts`.
 *
 * DB-free: the loaded judge agents and the structure are passed in, so this stays in the pure
 * `lib/app/**` layer. Per-judge failure is fail-soft.
 */

import type { Logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { EVALUATE_POLICY_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { EvaluatePolicyData } from '@/lib/app/questionnaire/capabilities/evaluate-policy';
import { POLICY_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/policy-evaluation/dimensions';
import type {
  PolicyEvaluationDimension,
  PolicyJudgeVerdict,
  PolicyStructureInput,
} from '@/lib/app/questionnaire/policy-evaluation/types';

/** One dimension's outcome: a verdict, or a diagnostic when its judge failed or was absent. */
export interface PolicyDimensionResult {
  dimension: PolicyEvaluationDimension;
  verdict?: PolicyJudgeVerdict;
  diagnostic?: string;
}

/** Aggregate tallies over the dispatched panel. */
export interface PolicyEvaluationPanelSummary {
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
}

export interface PolicyEvaluationPanelResult {
  results: PolicyDimensionResult[];
  summary: PolicyEvaluationPanelSummary;
}

/** The judge binding the dispatch needs — resolved by the route, never looked up here. */
export interface PolicyJudgeAgentRef {
  slug: string;
  id: string;
  provider: string | null;
  model: string | null;
  fallbackProviders: unknown;
}

export async function runPolicyEvaluationPanel(args: {
  dimensions: PolicyEvaluationDimension[];
  structure: PolicyStructureInput;
  questionnaireId: string;
  versionId: string;
  agentBySlug: Map<string, PolicyJudgeAgentRef>;
  adminId: string;
  log: Logger;
}): Promise<PolicyEvaluationPanelResult> {
  const { dimensions, structure, questionnaireId, versionId, agentBySlug, adminId, log } = args;

  // Idempotent, one-shot — registering once here keeps it off the per-dimension hot path.
  registerBuiltInCapabilities();

  const results: PolicyDimensionResult[] = await Promise.all(
    dimensions.map(async (dimension): Promise<PolicyDimensionResult> => {
      const agent = agentBySlug.get(POLICY_EVALUATION_DIMENSION_SPECS[dimension].slug);
      if (!agent) {
        log.warn('Policy judge agent missing for dimension; skipping', {
          questionnaireId,
          versionId,
          dimension,
        });
        return { dimension, diagnostic: 'judge_not_configured' };
      }

      // The dispatcher returns capability failures as `{ success: false }`, but can still THROW on
      // an infrastructure fault — wrapped so any throw degrades to this dimension's diagnostic
      // rather than rejecting the whole `Promise.all` and losing three good verdicts.
      let dispatch;
      try {
        dispatch = await capabilityDispatcher.dispatch(
          EVALUATE_POLICY_CAPABILITY_SLUG,
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
        log.error('Policy judge dispatch threw; returning diagnostic for dimension', {
          questionnaireId,
          versionId,
          dimension,
          error: err instanceof Error ? err.message : String(err),
        });
        return { dimension, diagnostic: 'dispatch_error' };
      }

      if (dispatch.success && dispatch.data) {
        return { dimension, verdict: (dispatch.data as EvaluatePolicyData).verdict };
      }
      log.warn('Policy judge dispatch failed; returning diagnostic for dimension', {
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
