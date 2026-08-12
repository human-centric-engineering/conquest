/**
 * Cross-judge reconciliation capability.
 *
 * A `BaseCapability` that runs ONE structured LLM call over the questions **more than one judge
 * flagged**, and returns one or two alternative phrasings per question that try to satisfy every
 * judge at once (see `reconcile-schema.ts` for why that is a separate step and not something a
 * judge could do itself).
 *
 * Batched, not per-question: the alternative for one question never depends on another, so the
 * batching buys nothing in quality — it buys one round-trip instead of N on a run that has already
 * spent seven, and it lets the model hold the questionnaire's voice in view while rewriting.
 *
 * Same discipline as `evaluate-structure`: provider-agnostic `runStructuredCompletion`
 * (call → parse → retry-once-at-temp-0 → cost-sum), the agent binding read from the dispatch
 * context, the `reasoning` tier, and the truncation-vs-schema failure split that the Clarity judge
 * incident taught us to keep. It persists nothing — `runEvaluationPanel` returns the result and the
 * run route writes it.
 *
 * Input is authored structure plus the panel's own critique (admin-facing content, not respondent
 * data), so `processesPii = false`. Boundary: `lib/app/**` — no Prisma, no Next.js.
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
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';

import {
  RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
  RECONCILE_SUGGESTIONS_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import { audienceShapeSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import {
  buildReconcilePrompt,
  buildReconcileRetryMessage,
  type ReconcileTargetInput,
} from '@/lib/app/questionnaire/evaluation/reconcile-prompt';
import {
  MAX_RECONCILED_TARGETS,
  validateReconcileResult,
  type ReconcileResult,
  type ReconciledSuggestion,
} from '@/lib/app/questionnaire/evaluation/reconcile-schema';
import { EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/evaluation/types';

const SLUG = RECONCILE_SUGGESTIONS_CAPABILITY_SLUG;

/**
 * Output budget. Up to 15 questions × 2 alternatives, each a full rewritten question plus a note —
 * and, on an OpenAI reasoning model, hidden reasoning tokens come out of the same allowance
 * (`max_completion_tokens`). Sized with the Clarity-judge truncation in mind: a response cut off
 * mid-JSON fails the whole batch, so the cap is generous relative to the realistic output.
 */
const RECONCILE_MAX_TOKENS = 8_192;

/** One reconcile call over a batch; a reasoning model rewriting 15 questions needs the room. */
const RECONCILE_TIMEOUT_MS = 90_000;

const judgeInputSchema = z.object({
  dimension: z.enum(EVALUATION_DIMENSIONS),
  label: z.string().min(1),
  severity: z.string().min(1),
  proposedChange: z.string().min(1),
  rationale: z.string().min(1),
});

const targetInputSchema = z.object({
  key: z.string().min(1),
  prompt: z.string().min(1),
  questionType: z.string().nullable().default(null),
  context: z.string().nullable().default(null),
  // Two or more, or there is nothing to reconcile — the caller filters, this enforces.
  judges: z.array(judgeInputSchema).min(2),
});

const argsSchema = z.object({
  targets: z.array(targetInputSchema).min(1).max(MAX_RECONCILED_TARGETS),
  goal: z.string().nullish(),
  audience: audienceShapeSchema.nullish(),
  versionId: z.string().optional(),
});

export type ReconcileSuggestionsArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the reconciled alternatives, keyed by target. */
export interface ReconcileSuggestionsData {
  suggestions: ReconciledSuggestion[];
}

/** Read the reconciler agent's binding from the dispatch context (empty → system default). */
function readReconcilerBinding(entityContext: CapabilityContext['entityContext']): ResolvableAgent {
  const raw = entityContext?.reconcilerAgent;
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

export class AppReconcileSuggestionsCapability extends BaseCapability<
  ReconcileSuggestionsArgs,
  ReconcileSuggestionsData
> {
  readonly slug = SLUG;
  readonly processesPii = false;
  readonly functionDefinition = RECONCILE_SUGGESTIONS_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  async execute(
    args: ReconcileSuggestionsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<ReconcileSuggestionsData>> {
    // 1. Resolve the binding. Rewriting a question so it survives six critiques is analysis →
    //    the `reasoning` tier, the same as the judges it is reconciling.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readReconcilerBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('reconcile_suggestions: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('reconcile_suggestions: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const targets: ReconcileTargetInput[] = args.targets;
    const messages = buildReconcilePrompt(targets, {
      goal: args.goal ?? null,
      audience: args.audience ?? null,
    });

    // 2. Structured call. `sawParseableJson` splits the two failure modes for the same reason
    //    `evaluate-structure` does: an empty issue-path list means "we never got JSON" (almost
    //    always truncation), not "the schema was satisfied".
    let lastIssuePaths: string[] = [];
    let sawParseableJson = false;
    let completion: StructuredCompletionResult<ReconcileResult>;
    try {
      completion = await runStructuredCompletion<ReconcileResult>({
        provider,
        model,
        messages,
        maxTokens: RECONCILE_MAX_TOKENS,
        timeoutMs: RECONCILE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            sawParseableJson = true;
            const validation = validateReconcileResult(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildReconcileRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            sawParseableJson
              ? 'Reconciler response was not valid against the schema after one retry' +
                  (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
              : `Reconciler response was not parseable JSON after one retry — most likely truncated at the token cap (maxTokens: ${RECONCILE_MAX_TOKENS})`
          ),
      });
    } catch (err) {
      logger.error('reconcile_suggestions: structured completion failed', {
        agentId: context.agentId,
        targetCount: targets.length,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        parseableJson: sawParseableJson,
        maxTokens: RECONCILE_MAX_TOKENS,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'reconciliation_failed');
    }

    // 3. Cost — fire-and-forget; an accounting write must never fail the run.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: SLUG,
        targetCount: targets.length,
        ...(args.versionId ? { versionId: args.versionId } : {}),
      },
    }).catch((err) => {
      logger.error('reconcile_suggestions: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 4. Drop anything addressed at a key we did not ask about. The model is told not to invent
    //    keys; this makes it true. A hallucinated key would otherwise attach an alternative to a
    //    question nobody flagged — or to nothing at all, where no reader would ever see it.
    const requested = new Set(targets.map((t) => t.key));
    const suggestions = completion.value.reconciliations.filter((r) => requested.has(r.targetKey));
    if (suggestions.length !== completion.value.reconciliations.length) {
      logger.warn('reconcile_suggestions: dropped reconciliations for unrequested keys', {
        agentId: context.agentId,
        returned: completion.value.reconciliations.length,
        kept: suggestions.length,
      });
    }

    return this.success({ suggestions });
  }
}
