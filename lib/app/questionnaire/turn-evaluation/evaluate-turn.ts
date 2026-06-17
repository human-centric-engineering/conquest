/**
 * Turn-evaluation service.
 *
 * Runs ONE structured LLM call that evaluates a single interview turn and returns the
 * validated {@link TurnEvaluation} verdict. Modelled on the design-evaluation judge
 * (`evaluate-structure`): a single provider-agnostic structured completion via
 * `runStructuredCompletion` (call → parse → retry-once-at-temp-0 → cost-sum), validated
 * against the Zod contract, with fire-and-forget cost logging.
 *
 * A plain service rather than a `BaseCapability`: it is a single call triggered by one route
 * (no per-item fan-out, no dispatcher reuse), so the lighter `run-panel`-style service is the
 * right altitude. The seeded `turn-evaluator` agent supplies the provider/model binding — the
 * route reads it and passes it here; an empty binding resolves to the system default via
 * `resolveAgentProviderAndModel`, the dynamic-resolution contract every seeded agent uses.
 *
 * Boundary: lives under `lib/app/**`. It imports the orchestration LLM helpers (the same set
 * `evaluate-structure` uses) but no `@/lib/db` and no Next.js — the route does the DB load.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';

import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import {
  runStructuredCompletion,
  tryParseJson,
  type StructuredCompletionResult,
} from '@/lib/orchestration/evaluations/parse-structured';

import { buildTurnEvaluatorPrompt } from '@/lib/app/questionnaire/turn-evaluation/prompt';
import {
  buildTurnEvaluatorRetryMessage,
  validateTurnEvaluation,
  type TurnEvaluation,
} from '@/lib/app/questionnaire/turn-evaluation/schema';
import type { TurnEvaluationInput } from '@/lib/app/questionnaire/turn-evaluation/types';

/** The verdict is a large multi-section object — give the completion ample headroom. */
const TURN_EVAL_MAX_TOKENS = 6_000;

/** One reasoning-model call over a turn dump; 60s covers a slow model without hanging. */
const TURN_EVAL_TIMEOUT_MS = 60_000;

/** What the service returns: the verdict plus the resolved binding and summed spend. */
export interface TurnEvaluationResult {
  verdict: TurnEvaluation;
  costUsd: number;
  model: string;
  provider: string;
}

/** Options for {@link evaluateTurn}. */
export interface EvaluateTurnOptions {
  /** The triggering agent's id, threaded into cost-log metadata. */
  agentId?: string;
  /** Stable session identity, threaded into cost-log metadata. */
  sessionId?: string;
}

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Evaluate one interview turn. Resolves the provider/model from `agent` (empty binding →
 * system default, `reasoning` tier — judging a turn is analysis), runs the structured
 * completion, logs cost fire-and-forget, and returns the validated verdict.
 *
 * Throws on an unresolved provider or a completion that fails validation after one retry —
 * the route maps those to a clean error envelope.
 */
export async function evaluateTurn(
  input: TurnEvaluationInput,
  agent: ResolvableAgent,
  opts: EvaluateTurnOptions = {}
): Promise<TurnEvaluationResult> {
  // 1. Resolve the provider/model binding (provider-agnostic). Empty binding → system
  //    default. Judging a turn is analysis → the `reasoning` tier.
  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  // 2. Build the system rubric + user (context + serialized dump) messages.
  const messages = buildTurnEvaluatorPrompt(input);

  // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Capture the Zod issue
  //    paths of the most recent schema-invalid (but JSON-parseable) response so a failure
  //    names WHICH fields were wrong, and the retry repairs them.
  let lastIssuePaths: string[] = [];
  let completion: StructuredCompletionResult<TurnEvaluation>;
  try {
    completion = await runStructuredCompletion<TurnEvaluation>({
      provider,
      model,
      messages,
      maxTokens: TURN_EVAL_MAX_TOKENS,
      timeoutMs: TURN_EVAL_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const validation = validateTurnEvaluation(parsed);
          if (validation.ok) return validation.value;
          lastIssuePaths = validation.issues.map((issue) =>
            issue.path.length > 0 ? issue.path.join('.') : '(root)'
          );
          return null;
        }),
      retryUserMessage: buildTurnEvaluatorRetryMessage(lastIssuePaths),
      onFinalFailure: () =>
        new Error(
          'Turn evaluation response was not valid against the schema after one retry' +
            (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
        ),
    });
  } catch (err) {
    logger.error('evaluate_turn: structured completion failed', {
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      model,
      provider: providerSlug,
      issuePaths: lastIssuePaths,
      error: errorMessage(err),
    });
    throw err;
  }

  // 4. Cost — fire-and-forget. An accounting write must never fail the evaluation.
  void logCost({
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    operation: CostOperation.CHAT,
    model,
    provider: providerSlug,
    inputTokens: completion.tokenUsage.input,
    outputTokens: completion.tokenUsage.output,
    metadata: {
      capability: 'turn-evaluation',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      turnIndex: input.turn.turnIndex,
    },
  }).catch((err) => {
    logger.error('evaluate_turn: logCost rejected', {
      agentId: opts.agentId,
      error: errorMessage(err),
    });
  });

  return {
    verdict: completion.value,
    costUsd: completion.costUsd,
    model,
    provider: providerSlug,
  };
}
