/**
 * Streaming Config Advisor orchestrator.
 *
 * Two phases over one questionnaire snapshot:
 *   NARRATIVE — `provider.chatStream` streams a plain-language review token-by-token (lifecycle
 *               state + the respondent experience the config produces). Each chunk is forwarded as a
 *               `narrative_delta`.
 *   ANALYSIS  — one structured completion (`runStructuredCompletion`) re-reads the snapshot plus the
 *               narrative and emits conflicts + one-click suggestions, forwarded as one `analysis`.
 *
 * It's an async generator: it `yield`s progress events and RETURNS nothing (the advisor is
 * ephemeral — nothing is persisted). It NEVER throws — a provider/parse failure surfaces as an
 * `error` event. The route drives it and emits the terminal `done`. NOT exported from a barrel — it
 * pulls provider/LLM imports, so only server code (the route) imports it by path. Mirrors
 * `stream-compose.ts`.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';

import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

import type { AdvisorContext } from '@/lib/app/questionnaire/advisor/context';
import type { AdvisorGenEvent } from '@/lib/app/questionnaire/advisor/advisor-events';
import {
  buildAdvisorNarrativePrompt,
  buildAdvisorSuggestionsPrompt,
  buildAdvisorRetryMessage,
} from '@/lib/app/questionnaire/advisor/advisor-prompt';
import {
  validateAdvisorAnalysis,
  type AdvisorAnalysis,
} from '@/lib/app/questionnaire/advisor/advisor-schema';

/** The narrative is a couple of short sections. */
const NARRATIVE_MAX_TOKENS = 2_048;
const NARRATIVE_TEMPERATURE = 0.4;
/** The structured analysis is a small JSON payload; reasoning models split this with thinking. */
const ANALYSIS_MAX_TOKENS = 3_072;
const ANALYSIS_TIMEOUT_MS = 90_000;

export interface StreamAdvisorParams {
  context: AdvisorContext;
  /** Provider binding for the advisor agent (provider, model, fallbacks). */
  agent: ResolvableAgent;
  /** For cost-log attribution. */
  agentId?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function* streamAdvisor(params: StreamAdvisorParams): AsyncGenerator<AdvisorGenEvent> {
  const { context, agent, agentId } = params;

  // Pre-flight: resolve the provider once. A failure here is fatal.
  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('advisor stream: no provider resolved', { agentId, error: errMsg(err) });
    yield {
      type: 'error',
      code: 'no_provider_configured',
      message: 'No LLM provider is configured for the Config Advisor agent.',
    };
    return;
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch (err) {
    logger.error('advisor stream: provider unavailable', {
      agentId,
      providerSlug,
      error: errMsg(err),
    });
    yield {
      type: 'error',
      code: 'provider_unavailable',
      message: 'The Config Advisor agent’s LLM provider is unavailable.',
    };
    return;
  }

  let totalInput = 0;
  let totalOutput = 0;

  // PHASE 1 — stream the narrative.
  let narrative = '';
  try {
    const stream = provider.chatStream(buildAdvisorNarrativePrompt(context), {
      model,
      temperature: NARRATIVE_TEMPERATURE,
      maxTokens: NARRATIVE_MAX_TOKENS,
      signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        narrative += chunk.content;
        yield { type: 'narrative_delta', text: chunk.content };
      } else if (chunk.type === 'done') {
        totalInput += chunk.usage.inputTokens;
        totalOutput += chunk.usage.outputTokens;
      }
    }
  } catch (err) {
    logger.error('advisor stream: narrative failed', { agentId, error: errMsg(err) });
    logUsage(totalInput, totalOutput, { agentId, model, providerSlug });
    yield {
      type: 'error',
      code: 'narrative_failed',
      message: 'Could not produce the advisor review. Please try again.',
    };
    return;
  }

  if (narrative.trim().length === 0) {
    logUsage(totalInput, totalOutput, { agentId, model, providerSlug });
    yield {
      type: 'error',
      code: 'narrative_empty',
      message: 'The advisor returned an empty review. Please try again.',
    };
    return;
  }

  yield { type: 'narrative_done' };

  // PHASE 2 — structured conflicts + suggestions.
  let analysis: AdvisorAnalysis;
  try {
    const completion = await runStructuredCompletion<AdvisorAnalysis>({
      provider,
      model,
      messages: buildAdvisorSuggestionsPrompt(context, narrative),
      maxTokens: ANALYSIS_MAX_TOKENS,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      parse: (raw) => tryParseJson(raw, validateAdvisorAnalysis),
      retryUserMessage: buildAdvisorRetryMessage(),
      onFinalFailure: () =>
        new Error('Advisor analysis was not valid against the schema after one retry'),
    });
    totalInput += completion.tokenUsage.input;
    totalOutput += completion.tokenUsage.output;
    analysis = completion.value;
  } catch (err) {
    logger.error('advisor stream: analysis failed', { agentId, error: errMsg(err) });
    logUsage(totalInput, totalOutput, { agentId, model, providerSlug });
    // The narrative already streamed — surface the analysis failure but keep what the admin saw.
    yield {
      type: 'error',
      code: 'analysis_failed',
      message:
        'The advisor wrote its review but could not produce structured suggestions. Try again.',
    };
    return;
  }

  logUsage(totalInput, totalOutput, { agentId, model, providerSlug });

  yield { type: 'analysis', conflicts: analysis.conflicts, suggestions: analysis.suggestions };
}

/** Fire-and-forget cost log for the whole two-phase run (summed across both calls). */
function logUsage(
  inputTokens: number,
  outputTokens: number,
  meta: { agentId?: string; model: string; providerSlug: string }
): void {
  void logCost({
    ...(meta.agentId ? { agentId: meta.agentId } : {}),
    operation: CostOperation.CHAT,
    model: meta.model,
    provider: meta.providerSlug,
    inputTokens,
    outputTokens,
    metadata: { capability: 'advisor' },
  }).catch((err) => {
    logger.error('advisor stream: logCost rejected', { agentId: meta.agentId, error: errMsg(err) });
  });
}
