/**
 * Conditional Topics evaluation capability (F17.21).
 *
 * A `BaseCapability` that runs ONE judge over a questionnaire version's Conditional Topics
 * configuration for ONE dimension and returns a {@link ScopeJudgeVerdict} — a continuous score in
 * [0, 1] plus a list of actionable findings (proposed edits). The scope evaluate-preview route
 * dispatches it once per dimension, passing each judge agent's resolvable binding; the four calls
 * together form the panel. Structurally identical to `evaluate-structure.ts` — see that file's doc
 * for the shared `BaseCapability` + `runStructuredCompletion` shape this mirrors.
 *
 * Unlike the answer capabilities, the input is the AUTHORED SCOPE CONFIG (topics, rules, planner
 * instructions, budget) — admin-managed content, not respondent personal data — so
 * `processesPii = false`.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { z } from 'zod';

import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { isWorkflowAgentId } from '@/lib/orchestration/capabilities/dispatcher';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';

import {
  EVALUATE_SCOPE_CAPABILITY_SLUG,
  EVALUATE_SCOPE_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import {
  SCOPE_EVALUATION_DIMENSIONS,
  buildScopeJudgePrompt,
  buildScopeJudgeRetryMessage,
  validateScopeJudgeVerdict,
  scopeStructureSchema,
  type ScopeJudgeVerdict,
  type ScopeJudgeVerdictOutput,
  type ScopeStructureInput,
} from '@/lib/app/questionnaire/scope-evaluation';

const SLUG = EVALUATE_SCOPE_CAPABILITY_SLUG;

/**
 * Output budget for one judge call — same generous cap as `evaluate-structure.ts`'s
 * `JUDGE_MAX_TOKENS`, for the same reason: a scope config is smaller than a long instrument, but a
 * judge attaching a full rewritten criteria block per finding can still legitimately run long, and
 * truncation that leaves partial content is silent (the provider only raises when content is empty).
 */
const JUDGE_MAX_TOKENS = 8_192;

/** One judge call; a reasoning model needs the full 90s, matching the design-evaluation judges. */
const JUDGE_TIMEOUT_MS = 90_000;

const argsSchema = z.object({
  /** Which dimension this judge scores. */
  dimension: z.enum(SCOPE_EVALUATION_DIMENSIONS),
  /** The scope structure DTO to judge — shape shared with the route loader. */
  structure: scopeStructureSchema,
  /** Stable version identity, threaded into cost-log metadata. */
  versionId: z.string().optional(),
});

export type EvaluateScopeArgs = z.infer<typeof argsSchema>;

/** What the capability returns: one judge's verdict for the dispatched dimension. */
export interface EvaluateScopeData {
  verdict: ScopeJudgeVerdict;
}

/**
 * Read the dispatched judge agent's resolvable binding from the dispatch context — identical
 * posture to `evaluate-structure.ts`'s `readJudgeAgentBinding`.
 */
function readJudgeAgentBinding(entityContext: CapabilityContext['entityContext']): ResolvableAgent {
  const raw = entityContext?.judgeAgent;
  if (isRecord(raw)) {
    return {
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      fallbackProviders: Array.isArray(raw.fallbackProviders)
        ? raw.fallbackProviders.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
  return { provider: '', model: '', fallbackProviders: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AppEvaluateScopeCapability extends BaseCapability<
  EvaluateScopeArgs,
  EvaluateScopeData
> {
  readonly slug = SLUG;
  readonly processesPii = false;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  readonly functionDefinition = EVALUATE_SCOPE_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  async execute(
    args: EvaluateScopeArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<EvaluateScopeData>> {
    // 1. Resolve the provider/model binding. Judging a config + emitting findings is analysis →
    //    the `reasoning` tier.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readJudgeAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('evaluate_scope: no provider resolved', {
        agentId: context.agentId,
        dimension: args.dimension,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('evaluate_scope: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the dimension-specific prompt from the validated structure.
    const structure: ScopeStructureInput = args.structure;
    const messages = buildScopeJudgePrompt(args.dimension, structure);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum).
    let lastIssuePaths: string[] = [];
    let sawParseableJson = false;
    let completion: StructuredCompletionResult<ScopeJudgeVerdictOutput>;
    try {
      completion = await runStructuredCompletion<ScopeJudgeVerdictOutput>({
        provider,
        model,
        messages,
        maxTokens: JUDGE_MAX_TOKENS,
        timeoutMs: JUDGE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            sawParseableJson = true;
            const validation = validateScopeJudgeVerdict(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildScopeJudgeRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            sawParseableJson
              ? 'Scope judge response was not valid against the schema after one retry' +
                  (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
              : `Scope judge response was not parseable JSON after one retry — most likely truncated at the token cap (maxTokens: ${JUDGE_MAX_TOKENS}); raise JUDGE_MAX_TOKENS if this dimension needs a longer answer`
          ),
      });
    } catch (err) {
      logger.error('evaluate_scope: structured completion failed', {
        agentId: context.agentId,
        dimension: args.dimension,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        parseableJson: sawParseableJson,
        maxTokens: JUDGE_MAX_TOKENS,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'evaluation_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the pass.
    void logCost({
      // A workflow step dispatches with `workflow:<id>` in `agentId`, which is not
      // an AiAgent row — the FK violation is caught inside logCost and the cost row
      // silently never exists (Sunrise #599/#600). Attribute only a real agent id.
      ...(context.agentId && !isWorkflowAgentId(context.agentId)
        ? { agentId: context.agentId }
        : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: SLUG,
        dimension: args.dimension,
        ...(args.versionId ? { versionId: args.versionId } : {}),
      },
    }).catch((err) => {
      logger.error('evaluate_scope: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Stamp the dimension (the LLM never labels its own verdict) and return.
    const verdict: ScopeJudgeVerdict = {
      dimension: args.dimension,
      score: completion.value.score,
      findings: completion.value.findings,
    };

    return this.success({ verdict });
  }
}
