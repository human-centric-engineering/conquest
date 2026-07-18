/**
 * Cost attribution for the app's direct LLM calls (F14.15).
 *
 * ## Why this exists
 *
 * ConQuest grew two disjoint spend paths. Orchestration-tier calls (chat, workflows, evaluations)
 * route through `logCost` and land in `AiCostLog`. But the app's own reasoning calls — report
 * generation, cohort reports, scoring-schema extraction, contradiction detection — call
 * `getProvider` directly and logged nothing at all. That spend was invisible to `cost-reports.ts`
 * AND to per-agent budget enforcement, which meant `.context/orchestration/report-web-search.md`
 * documented a research-spend cap that could not fire.
 *
 * A second, unlogged spend path is worse than no cost tracking, because the dashboard looks
 * complete while under-reporting. This helper is the one seam those call sites use.
 *
 * ## Why a wrapper rather than calling `logCost` directly
 *
 * Two reasons. First, `AiCostLog` has only three FK columns (`agentId`, `conversationId`,
 * `workflowExecutionId`) — none of which is a questionnaire version — so app rows must carry
 * `versionId` in `metadata` or they can never be joined back to the artifact they produced. Four
 * of six authoring call sites previously omitted it. Requiring it here makes that impossible.
 * Second, every call site wants the same fire-and-forget error posture, and repeating
 * `.catch(() => {})` twelve times invites one site to get it wrong.
 */

import { CostOperation } from '@/types/orchestration';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';

/** Token counts as `runStructuredCompletion` reports them. */
export interface AppTokenUsage {
  input: number;
  output: number;
}

export interface LogAppCostParams {
  /** The seeded agent whose binding served the call — drives per-agent budget enforcement. */
  agentId: string;
  /** Resolved provider slug + model id (post-fallback), not the agent's configured preference. */
  provider: string;
  model: string;
  tokenUsage: AppTokenUsage;
  /**
   * Which app capability spent this. Prefixed `app_` by convention so app spend is separable
   * from platform spend in a single `metadata` filter.
   */
  capability: string;
  /**
   * The questionnaire version the spend belongs to. Required (nullable only where genuinely
   * version-less) so cost rows can always be joined to the artifact they produced.
   */
  versionId: string | null;
  /** Any extra per-capability context worth keeping on the row. */
  extra?: Record<string, unknown>;
}

/**
 * Log one app LLM call's cost. Fire-and-forget: cost attribution must never fail the user's
 * action, and `logCost` already swallows its own provider-pricing lookups.
 */
export function logAppLlmCost(params: LogAppCostParams): void {
  // The try/catch is load-bearing, not belt-and-braces. `.catch()` alone only handles a REJECTED
  // promise — if `logCost` throws synchronously (or returns a non-promise, as a partial test mock
  // does), the throw propagates into the caller's try block. In `report/research.ts` that would
  // silently degrade a whole research phase to an empty result because a cost row failed to
  // write. Cost attribution must never be able to change the caller's outcome.
  try {
    void logCost({
      agentId: params.agentId,
      operation: CostOperation.CHAT,
      model: params.model,
      provider: params.provider,
      inputTokens: params.tokenUsage.input,
      outputTokens: params.tokenUsage.output,
      metadata: {
        capability: params.capability,
        versionId: params.versionId,
        ...(params.extra ?? {}),
      },
    })?.catch(() => {});
  } catch {
    // Deliberately silent: `logCost` already logs its own failures.
  }
}
