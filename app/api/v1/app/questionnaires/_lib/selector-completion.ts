/**
 * Shared selector-agent runner — a DIRECT structured LLM completion (NOT `drainStreamChat`).
 *
 * Both adaptive selectors (question-mode `adaptive` strategy and data-slot mode) ask the seeded
 * `app-questionnaire-selector` agent to pick the best next candidate. They used to drive it through
 * `drainStreamChat`, which persists an `AiConversation` keyed to a REAL `user` row — so it FK-violated
 * on the synthetic `anon:<sessionId>` user that anonymous (no-login) AND admin-preview sessions carry
 * (preview sessions have a null `respondentUserId`, which `resolveTurnAccess` treats as anonymous).
 * To avoid the 500, both selectors SKIPPED the LLM pick for anonymous sessions and fell back to the
 * deterministic order — which silently disabled adaptive, respondent-led selection in preview and on
 * every public questionnaire.
 *
 * Running the selector as a structured completion (the same mechanism the seriousness/sensitivity
 * judges already use, which run fine for anonymous sessions) removes that constraint entirely: no
 * conversation row, no user FK, so it works identically for authenticated, anonymous, and preview
 * sessions. Fail-soft: a missing provider/model or a completion failure returns an `errorCode` and the
 * caller falls back to the deterministic pick — never throws.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { QUESTIONNAIRE_SELECTOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/** The selector agent's pinned output envelope. */
export interface SelectorOutput {
  /** 1-based index into the candidate list, or 0 for "none fits". */
  choice: number;
  rationale: string;
}

/** Validate the selector agent's JSON reply into a {@link SelectorOutput}. */
export function parseSelectorOutput(raw: string): SelectorOutput | null {
  return tryParseJson<SelectorOutput>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.choice !== 'number' || !Number.isFinite(obj.choice)) return null;
    const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
    return { choice: Math.trunc(obj.choice), rationale };
  });
}

/** What the shared runner returns — enough for each caller to trace + map to its own outcome. */
export interface SelectorCompletionResult {
  /** The parsed `{ choice, rationale }`, or `null` when the reply was unparseable / failed. */
  parsed: SelectorOutput | null;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Set when provider/model resolution or the completion failed — caller defers to deterministic. */
  errorCode?: 'no_provider' | 'provider_unavailable' | 'completion_failed';
}

/**
 * Run the seeded selector agent over a pre-built user message and return its parsed pick. The agent's
 * persona is its DB `systemInstructions`; an unset provider/model resolves to the system default (as
 * the seeded selector is configured). Never throws — failures come back as an `errorCode`.
 */
export async function runSelectorCompletion(opts: {
  /** The fully-rendered per-turn selector prompt (candidate list + transcript + JSON contract). */
  userMessage: string;
  /** Session id — cost attribution only (no conversation is persisted). */
  sessionId: string;
}): Promise<SelectorCompletionResult> {
  const startedAt = Date.now();
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG },
    select: {
      id: true,
      provider: true,
      model: true,
      fallbackProviders: true,
      systemInstructions: true,
    },
  });

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(
      agent
        ? {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          }
        : { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('selector: no provider resolved', {
      sessionId: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      parsed: null,
      model: '',
      provider: '',
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      tokensIn: 0,
      tokensOut: 0,
      errorCode: 'no_provider',
    };
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch {
    return {
      parsed: null,
      model,
      provider: providerSlug,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      tokensIn: 0,
      tokensOut: 0,
      errorCode: 'provider_unavailable',
    };
  }

  const messages: LlmMessage[] = [
    ...(agent?.systemInstructions
      ? [{ role: 'system' as const, content: agent.systemInstructions }]
      : []),
    { role: 'user' as const, content: opts.userMessage },
  ];

  try {
    const completion = await runStructuredCompletion<SelectorOutput>({
      provider,
      model,
      messages,
      maxTokens: 200,
      timeoutMs: 30_000,
      parse: (raw) => parseSelectorOutput(raw),
      retryUserMessage:
        'Return ONLY the JSON object {"choice": <1-based number, or 0 if none fits>, "rationale": "<one short sentence>"}.',
    });

    void logCost({
      ...(agent ? { agentId: agent.id } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: 'app_questionnaire_selection',
        appQuestionnaireSessionId: opts.sessionId,
      },
    }).catch((err) => {
      logger.error('selector: logCost rejected', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      parsed: completion.value,
      model,
      provider: providerSlug,
      costUsd: completion.costUsd,
      latencyMs: Date.now() - startedAt,
      tokensIn: completion.tokenUsage.input,
      tokensOut: completion.tokenUsage.output,
    };
  } catch (err) {
    logger.warn('selector: structured completion failed; caller will defer to deterministic pick', {
      sessionId: opts.sessionId,
      model,
      provider: providerSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      parsed: null,
      model,
      provider: providerSlug,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      tokensIn: 0,
      tokensOut: 0,
      errorCode: 'completion_failed',
    };
  }
}
