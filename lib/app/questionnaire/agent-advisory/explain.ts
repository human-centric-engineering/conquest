/**
 * "Explain with AI" orchestrator — the hybrid layer of the Agent Settings
 * Evaluation surface.
 *
 * Given an agent slug, it re-uses the deterministic evaluation for that one
 * agent, then runs a single structured reasoning completion (the seeded
 * `app-agent-settings-advisor` binding) to produce a plain-language explanation
 * plus an optional applyable suggestion. Returns a discriminated result rather
 * than throwing, so the route can map failures to clean error responses.
 *
 * Server-only (Prisma + provider). One LLM call per invocation; cost is logged.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { prisma } from '@/lib/db/client';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

import { evaluateAgentSettings } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import {
  buildExplainPrompt,
  buildExplainRetryMessage,
} from '@/lib/app/questionnaire/agent-advisory/explain-prompt';
import {
  AGENT_SETTINGS_ADVISOR_SLUG,
  validateAgentSettingsExplanation,
  type AgentSettingsExplanation,
} from '@/lib/app/questionnaire/agent-advisory/explain-schema';

const EXPLAIN_MAX_TOKENS = 3_072;
const EXPLAIN_TIMEOUT_MS = 60_000;

export type ExplainResult =
  { ok: true; value: AgentSettingsExplanation } | { ok: false; code: string; message: string };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function explainAgentSettings(slug: string): Promise<ExplainResult> {
  // 1. Pull the deterministic evaluation for this one agent.
  const evaluation = await evaluateAgentSettings();
  const agentEval = evaluation.agents.find((a) => a.slug === slug);
  if (!agentEval) {
    return { ok: false, code: 'agent_not_found', message: `Unknown or unseeded agent: ${slug}` };
  }

  // 2. Resolve the advisor binding (provider-agnostic; empty model/provider).
  const advisor = await prisma.aiAgent.findUnique({
    where: { slug: AGENT_SETTINGS_ADVISOR_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!advisor) {
    logger.error('agent-settings explain: advisor agent not seeded; run db:seed', {
      slug: AGENT_SETTINGS_ADVISOR_SLUG,
    });
    return {
      ok: false,
      code: 'advisor_not_configured',
      message: 'The Agent Settings Advisor is not configured. Run the seeds.',
    };
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(
      {
        provider: advisor.provider,
        model: advisor.model,
        fallbackProviders: advisor.fallbackProviders,
      },
      'reasoning'
    );
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('agent-settings explain: no provider resolved', { error: errMsg(err) });
    return {
      ok: false,
      code: 'no_provider_configured',
      message: 'No LLM provider is configured for the advisor agent.',
    };
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch (err) {
    logger.error('agent-settings explain: provider unavailable', {
      providerSlug,
      error: errMsg(err),
    });
    return {
      ok: false,
      code: 'provider_unavailable',
      message: 'The advisor’s LLM provider is unavailable.',
    };
  }

  // 3. One structured completion.
  try {
    const completion = await runStructuredCompletion<AgentSettingsExplanation>({
      provider,
      model,
      messages: buildExplainPrompt(agentEval),
      maxTokens: EXPLAIN_MAX_TOKENS,
      timeoutMs: EXPLAIN_TIMEOUT_MS,
      parse: (raw) => tryParseJson(raw, validateAgentSettingsExplanation),
      retryUserMessage: buildExplainRetryMessage(),
      onFinalFailure: () =>
        new Error('Explanation was not valid against the schema after one retry'),
    });

    void logCost({
      agentId: advisor.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'agent-settings-advisor', subjectSlug: slug },
    }).catch((err) => {
      logger.error('agent-settings explain: logCost rejected', { error: errMsg(err) });
    });

    return { ok: true, value: completion.value };
  } catch (err) {
    logger.error('agent-settings explain: completion failed', { slug, error: errMsg(err) });
    return {
      ok: false,
      code: 'explain_failed',
      message: 'The advisor could not produce an explanation. Please try again.',
    };
  }
}
