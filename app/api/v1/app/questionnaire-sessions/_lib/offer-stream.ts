/**
 * Streaming completion-offer composer for the live turn route (F6.1, PR5).
 *
 * The F4.5 `compose-completion-offer` capability returns structured JSON (offer + recap),
 * so its tokens can't be streamed as prose. For the live surface the respondent should see
 * the warm wrap-up message appear token-by-token, so this composes a **plain-prose** offer
 * and streams it straight off `provider.chatStream` — the same provider layer the platform
 * chat handler uses, NOT `streamChat`.
 *
 * It's an async generator that yields `content` {@link ChatEvent} frames as the model emits
 * them and **returns** the accumulated message + cost, so the route delegates with
 * `const { message, costUsd } = yield* streamOfferMessage(...)`. Fail-soft throughout: a
 * missing agent, no provider, or a mid-stream error yields a deterministic fallback as a
 * single frame and returns it — an offer turn must always produce something to act on.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import type { ChatEvent } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getTextContent, type LlmMessage } from '@/lib/orchestration/llm/types';
import { QUESTIONNAIRE_COMPLETION_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { RecordAgentCall } from '@/lib/app/questionnaire/inspector';
import type { OfferComposeInput } from '@/lib/app/questionnaire/orchestrator';

/** Deterministic fallback offer when phrasing is unavailable or fails (fail-soft). */
export const FALLBACK_OFFER_MESSAGE =
  "Thanks — I think we've covered enough. Would you like to submit your responses now?";

/** Token budget + timeout for the (short) offer prose. */
const OFFER_MAX_TOKENS = 400;
const OFFER_TIMEOUT_MS = 30_000;

/** Build the plain-prose offer prompt — explicitly NOT JSON, so the tokens stream as prose. */
export function buildStreamingOfferPrompt(input: OfferComposeInput): LlmMessage[] {
  const covered = input.coveredSlots.map((s) => `- ${s.prompt}`).join('\n') || '- (nothing yet)';
  const remaining = input.remainingSlots.map((s) => `- ${s.prompt}`).join('\n');
  const pct = Math.round(input.coverage * 100);

  const system =
    'You are a warm, concise questionnaire assistant. The respondent has answered enough ' +
    'to submit. Write a short, friendly message (2–3 sentences) that briefly acknowledges ' +
    'what they covered and invites them to submit now — or keep going if they prefer. ' +
    'Reply with plain conversational prose only: no JSON, no lists, no headings, no preamble.' +
    // F6.3 soft cost cap: nudge toward wrapping up without alarming the respondent about cost.
    (input.costWrapUp
      ? ' This session is approaching its limit, so gently encourage them to wrap up and ' +
        'submit now rather than continue, and keep the message especially brief.'
      : '');

  const user =
    `Coverage: ${pct}% across ${input.answeredCount} answered question(s).` +
    (input.capReached ? ' (The session question limit was reached.)' : '') +
    `\n\nCovered:\n${covered}` +
    (remaining ? `\n\nStill optional:\n${remaining}` : '') +
    '\n\nWrite the wrap-up message now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** What {@link streamOfferMessage} returns once the stream completes. */
export interface StreamedOffer {
  message: string;
  costUsd: number;
}

/**
 * Stream a completion-offer message, yielding `content` frames and returning the full
 * message + cost. Fail-soft: yields {@link FALLBACK_OFFER_MESSAGE} as one frame on any
 * failure and returns it.
 */
export async function* streamOfferMessage(opts: {
  input: OfferComposeInput;
  userId: string;
  sessionId: string;
  /** Preview Turn Inspector (admin-only): records this offer-composition call's trace when supplied. */
  recordInspectorCall?: RecordAgentCall;
}): AsyncGenerator<ChatEvent, StreamedOffer, undefined> {
  const startedAt = Date.now();
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    yield { type: 'content', delta: FALLBACK_OFFER_MESSAGE };
    return { message: FALLBACK_OFFER_MESSAGE, costUsd: 0 };
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(
      { provider: agent.provider, model: agent.model, fallbackProviders: agent.fallbackProviders },
      'chat'
    );
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('streamOfferMessage: no provider resolved', {
      sessionId: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    yield { type: 'content', delta: FALLBACK_OFFER_MESSAGE };
    return { message: FALLBACK_OFFER_MESSAGE, costUsd: 0 };
  }

  const messages = buildStreamingOfferPrompt(opts.input);

  let accumulated = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  try {
    const provider = await getProvider(providerSlug);
    const stream = provider.chatStream(messages, {
      model,
      maxTokens: OFFER_MAX_TOKENS,
      timeoutMs: OFFER_TIMEOUT_MS,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        accumulated += chunk.content;
        yield { type: 'content', delta: chunk.content };
      } else if (chunk.type === 'done') {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    logger.error('streamOfferMessage: stream failed', {
      sessionId: opts.sessionId,
      provider: providerSlug,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    // If nothing streamed yet, emit the fallback so the respondent still gets an offer.
    if (accumulated.length === 0) {
      yield { type: 'content', delta: FALLBACK_OFFER_MESSAGE };
      return { message: FALLBACK_OFFER_MESSAGE, costUsd: 0 };
    }
  }

  const message = accumulated.trim().length > 0 ? accumulated : FALLBACK_OFFER_MESSAGE;
  let costUsd = 0;
  if (usage) {
    costUsd = calculateCost(model, usage.inputTokens, usage.outputTokens).totalCostUsd;
    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metadata: { capability: 'app_compose_completion_offer_stream', sessionId: opts.sessionId },
    }).catch((err) => {
      logger.error('streamOfferMessage: logCost rejected', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (opts.recordInspectorCall) {
    opts.recordInspectorCall({
      label: 'Completion offer',
      model,
      provider: providerSlug,
      latencyMs: Date.now() - startedAt,
      costUsd,
      ...(usage ? { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens } : {}),
      prompt: messages.map((m) => ({ role: m.role, content: getTextContent(m.content) })),
      response: message,
    });
  }

  return { message, costUsd };
}
