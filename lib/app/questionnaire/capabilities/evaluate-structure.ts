/**
 * Design-time structure-evaluation capability (F5.1).
 *
 * A `BaseCapability` that runs ONE judge over a questionnaire version's structure for
 * ONE dimension and returns a {@link JudgeVerdict} — a continuous score in [0, 1] plus
 * a list of actionable findings (proposed edits). The evaluate-preview route dispatches
 * it once per dimension, passing each judge agent's resolvable binding; the seven calls
 * together form the panel.
 *
 * Modelled on F4.5's `compose-completion-offer`: a single provider-agnostic structured
 * LLM call via `runStructuredCompletion` (call → parse → retry-once-at-temp-0 →
 * cost-sum), validated against the F5.1 Zod contract. It persists nothing — F5.2 adds
 * the run + suggestion models and the persisting route; F5.1's route is a no-persistence
 * preview so admins can tune the panel before launch.
 *
 * Unlike the answer capabilities, the input is the **authored structure** (goal,
 * audience, question prompts) — admin-managed content, not respondent personal data —
 * so `processesPii = false` and no `redactProvenance` override is needed.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js. The
 * dimension's rubric comes from the pure prompt builder (`buildJudgePrompt`); the
 * judge agent's provider/model binding is read from the dispatch context (the route
 * supplies it), falling back to an empty binding that `resolveAgentProviderAndModel`
 * fills from the system default — the dynamic-resolution contract every seeded agent
 * uses.
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
  EVALUATE_STRUCTURE_CAPABILITY_SLUG,
  EVALUATE_STRUCTURE_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import {
  EVALUATION_DIMENSIONS,
  buildJudgePrompt,
  buildJudgeRetryMessage,
  validateJudgeVerdict,
  versionStructureSchema,
  type JudgeVerdict,
  type JudgeVerdictOutput,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';

const SLUG = EVALUATE_STRUCTURE_CAPABILITY_SLUG;

/**
 * Output budget for one judge call.
 *
 * Sized for the worst case, not the average. Two things make the worst case big:
 *
 *  1. Clarity attaches a full rewritten prompt (`replace_prompt`) to every finding, so a
 *     long instrument legitimately runs to thousands of output tokens.
 *  2. On OpenAI's reasoning families (`o*`, `gpt-5*` — see `resolveParamProfile`) this cap
 *     is sent as `max_completion_tokens`, which covers hidden reasoning tokens AND visible
 *     output combined. The visible share is whatever reasoning leaves behind.
 *
 * The previous 2,048 was the smallest budget of any structured app capability and truncated
 * the Clarity judge mid-JSON on real questionnaires. Truncation that leaves *partial* content
 * is silent — the provider only raises when the content is empty — so it surfaced as a
 * misleading "not valid against the schema" failure. Keep this generous; the judge stops when
 * it has said its piece, so the cap costs nothing on a short questionnaire.
 */
const JUDGE_MAX_TOKENS = 8_192;

/** One judge call; a reasoning model over a long instrument needs the full 90s. */
const JUDGE_TIMEOUT_MS = 90_000;

const argsSchema = z.object({
  /** Which dimension this judge scores. */
  dimension: z.enum(EVALUATION_DIMENSIONS),
  /** The version structure DTO to judge — shape shared with the route loader. */
  structure: versionStructureSchema,
  /** Stable version identity, threaded into cost-log metadata. */
  versionId: z.string().optional(),
});

export type EvaluateStructureArgs = z.infer<typeof argsSchema>;

/** What the capability returns: one judge's verdict for the dispatched dimension. */
export interface EvaluateStructureData {
  verdict: JudgeVerdict;
}

/**
 * Read the dispatched judge agent's resolvable binding from the dispatch context. The
 * route sets `entityContext.judgeAgent` to the agent's
 * `{ provider, model, fallbackProviders }`; we validate defensively (never trust the
 * shape) and fall back to an empty binding so the capability still resolves to the
 * system default when called without it (tests, CLI).
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

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AppEvaluateStructureCapability extends BaseCapability<
  EvaluateStructureArgs,
  EvaluateStructureData
> {
  readonly slug = SLUG;
  readonly processesPii = false;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  // Source of truth lives in constants.ts.
  readonly functionDefinition = EVALUATE_STRUCTURE_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  async execute(
    args: EvaluateStructureArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<EvaluateStructureData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding →
    //    system default. Judging structure + emitting findings is analysis → the
    //    `reasoning` tier.
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
      logger.error('evaluate_structure: no provider resolved', {
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
      logger.error('evaluate_structure: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the dimension-specific prompt from the validated structure. The Zod
    //    parse already narrowed `structure` to the pure DTO shape.
    const structure: VersionStructureInput = args.structure;
    const messages = buildJudgePrompt(args.dimension, structure);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Two failure modes are
    //    worth telling apart, because the operator fix differs:
    //
    //      - the response parsed as JSON but broke the contract → name the Zod issue paths;
    //      - the response never parsed as JSON at all → almost always truncation at the
    //        token cap (a reasoning model spends the cap on reasoning, then gets cut off
    //        mid-object), which the provider cannot raise for us because the content is
    //        non-empty. Say so, and name the cap, rather than blaming "the schema".
    //
    //    `sawParseableJson` flips only inside the validate callback, which `tryParseJson`
    //    reaches only after a successful `JSON.parse` — so it is exactly "we got JSON".
    let lastIssuePaths: string[] = [];
    let sawParseableJson = false;
    let completion: StructuredCompletionResult<JudgeVerdictOutput>;
    try {
      completion = await runStructuredCompletion<JudgeVerdictOutput>({
        provider,
        model,
        messages,
        maxTokens: JUDGE_MAX_TOKENS,
        timeoutMs: JUDGE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            sawParseableJson = true;
            const validation = validateJudgeVerdict(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildJudgeRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            sawParseableJson
              ? 'Judge response was not valid against the schema after one retry' +
                  (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
              : `Judge response was not parseable JSON after one retry — most likely truncated at the token cap (maxTokens: ${JUDGE_MAX_TOKENS}); raise JUDGE_MAX_TOKENS if this dimension needs a longer answer`
          ),
      });
    } catch (err) {
      logger.error('evaluate_structure: structured completion failed', {
        agentId: context.agentId,
        dimension: args.dimension,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        // Without these, an empty `issuePaths` reads as "no schema problems" when it
        // actually means "we never got JSON" — the exact ambiguity that made the prod
        // Clarity failure look like a schema bug.
        parseableJson: sawParseableJson,
        maxTokens: JUDGE_MAX_TOKENS,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'evaluation_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the pass.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
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
      logger.error('evaluate_structure: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Stamp the dimension (the LLM never labels its own verdict) and return.
    const verdict: JudgeVerdict = {
      dimension: args.dimension,
      score: completion.value.score,
      findings: completion.value.findings,
    };

    return this.success({ verdict });
  }
}
