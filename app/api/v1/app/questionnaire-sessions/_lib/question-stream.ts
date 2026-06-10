/**
 * Streaming conversational question phraser for the live turn route.
 *
 * F6.1's orchestrator surfaces the next question's raw `prompt` verbatim. This restores the
 * originally-planned "warm conversational interviewer" voice (`Conversational Questionnaire
 * Phases.md` §Phase 6) for the *asked question*: it renders the targeted question as natural
 * prose — briefly acknowledging what the respondent just said, calibrating tone to the
 * audience/locale, and re-asking conversationally when the prior answer wasn't captured —
 * streamed token-by-token straight off `provider.chatStream` (the same path the F4.5 offer
 * composer uses, NOT `streamChat`).
 *
 * It's an async generator that yields `content` {@link ChatEvent} frames and **returns** the
 * accumulated message + cost, so the route delegates with
 * `const { message, costUsd } = yield* streamQuestionMessage(...)`. Fail-soft throughout: a
 * missing agent, no provider, or a mid-stream error before any token falls back to the
 * **verbatim prompt** as a single frame and returns it — a question is never lost.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import type { ChatEvent } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { QUESTION_TYPE_LABELS, type QuestionType } from '@/lib/app/questionnaire/types';
import { QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/** Token budget + timeout for the (short) conversational question prose. */
const QUESTION_MAX_TOKENS = 220;
const QUESTION_TIMEOUT_MS = 20_000;

/** Audience calibration fields the interviewer uses to set tone + language. */
export interface QuestionAudience {
  role?: string;
  expertiseLevel?: string;
  sensitivity?: string;
  locale?: string;
}

/** Everything the interviewer needs to phrase one asked question. */
export interface QuestionComposeInput {
  /** The raw question prompt — what to phrase, and the verbatim fail-soft fallback. */
  prompt: string;
  /** Question type, so a choice/scale question can offer its options naturally. */
  type: QuestionType;
  /** Raw `typeConfig` (opaque Json); options/scale labels are extracted best-effort. */
  typeConfig?: unknown;
  /** Optional answer guidance attached to the question. */
  guidelines?: string;
  /** Questionnaire goal — calibrates depth/framing, if set. */
  goal?: string;
  /** Audience metadata — calibrates tone, expertise, sensitivity, and language. */
  audience?: QuestionAudience;
  /** Recent transcript (oldest → newest) for continuity. */
  recentMessages: string[];
  /** The respondent's message this turn (to acknowledge); empty on the opening turn. */
  lastUserMessage: string;
  /** True when this same question was just asked and the prior answer wasn't captured. */
  isReask: boolean;
  /** True for the first question of the session (nothing to acknowledge yet). */
  isOpening: boolean;
}

/** What {@link streamQuestionMessage} returns once the stream completes. */
export interface StreamedQuestion {
  message: string;
  costUsd: number;
}

/**
 * Best-effort options/scale labels from an opaque `typeConfig`. Questionnaire slots store
 * choice/likert metadata under a few shapes (`options`, `choices`, `labels`, `scale`); we pull
 * any string array we recognise so the interviewer can offer the choices naturally. Returns
 * `undefined` when nothing usable is present — the phraser then just asks the question.
 */
export function extractOptionLabels(typeConfig: unknown): string[] | undefined {
  if (typeConfig === null || typeof typeConfig !== 'object') return undefined;
  const cfg = typeConfig as Record<string, unknown>;
  for (const key of ['options', 'choices', 'labels', 'scale']) {
    const value = cfg[key];
    if (Array.isArray(value)) {
      const labels = value
        .map((v) =>
          typeof v === 'string'
            ? v
            : v !== null &&
                typeof v === 'object' &&
                typeof (v as Record<string, unknown>).label === 'string'
              ? ((v as Record<string, unknown>).label as string)
              : null
        )
        .filter((v): v is string => v !== null && v.trim().length > 0);
      if (labels.length > 0) return labels;
    }
  }
  return undefined;
}

/** Build the plain-prose interviewer prompt — explicitly NOT JSON, so tokens stream as prose. */
export function buildStreamingQuestionPrompt(input: QuestionComposeInput): LlmMessage[] {
  const a = input.audience ?? {};
  const calibration: string[] = [];
  if (a.role) calibration.push(`The respondent's role: ${a.role}.`);
  if (a.expertiseLevel === 'novice')
    calibration.push('They are novices — prefer plain language, avoid jargon.');
  else if (a.expertiseLevel === 'expert')
    calibration.push('They are experts — you may use domain terms without explaining them.');
  if (a.sensitivity === 'high')
    calibration.push('This topic is sensitive — slow down and acknowledge difficulty gently.');
  if (a.locale && a.locale.toLowerCase() !== 'en' && !a.locale.toLowerCase().startsWith('en-'))
    calibration.push(`Respond entirely in the respondent's language (locale "${a.locale}").`);

  const system =
    'You are a warm, conversational interviewer guiding someone through a questionnaire. ' +
    'Ask the ONE question provided, naturally — never as a numbered form field, never restate ' +
    'the whole survey, never invent new questions, and never answer on their behalf. ' +
    (input.isOpening
      ? 'This is the first question — open warmly, no need to acknowledge a prior answer. '
      : input.isReask
        ? 'You already asked this question but could not capture a usable answer from their last ' +
          'reply — gently say you want to make sure you get it right, then re-ask it clearly. '
        : 'Briefly acknowledge what they just said (a few words), then ask the next question. ') +
    (input.goal ? `Questionnaire goal: ${input.goal}. ` : '') +
    (calibration.length > 0 ? calibration.join(' ') + ' ' : '') +
    'Match the respondent’s tone. Keep it to one or two sentences. ' +
    'Reply with plain conversational prose only: no JSON, no lists, no headings, no preamble, no quotation marks.';

  const options = extractOptionLabels(input.typeConfig);
  const transcript = input.recentMessages.slice(-6).join('\n');

  const user =
    `The question to ask (type: ${QUESTION_TYPE_LABELS[input.type]}):\n"${input.prompt}"` +
    (options ? `\n\nOffer these choices naturally: ${options.join(', ')}.` : '') +
    (input.guidelines
      ? `\n\nAnswer guidance (for you, do not read aloud): ${input.guidelines}`
      : '') +
    (transcript ? `\n\nRecent conversation:\n${transcript}` : '') +
    (input.lastUserMessage.trim().length > 0
      ? `\n\nThe respondent just said: "${input.lastUserMessage.trim()}"`
      : '') +
    '\n\nWrite your conversational message now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Stream a conversational rendering of the asked question, yielding `content` frames and
 * returning the full message + cost. Fail-soft: yields the verbatim `input.prompt` as one frame
 * on any failure (missing agent, no provider, mid-stream error before any token) and returns it.
 */
export async function* streamQuestionMessage(opts: {
  input: QuestionComposeInput;
  userId: string;
  sessionId: string;
}): AsyncGenerator<ChatEvent, StreamedQuestion, undefined> {
  const fallback = opts.input.prompt;

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    yield { type: 'content', delta: fallback };
    return { message: fallback, costUsd: 0 };
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
    logger.error('streamQuestionMessage: no provider resolved', {
      sessionId: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    yield { type: 'content', delta: fallback };
    return { message: fallback, costUsd: 0 };
  }

  const messages = buildStreamingQuestionPrompt(opts.input);

  let accumulated = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  try {
    const provider = await getProvider(providerSlug);
    const stream = provider.chatStream(messages, {
      model,
      maxTokens: QUESTION_MAX_TOKENS,
      timeoutMs: QUESTION_TIMEOUT_MS,
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
    logger.error('streamQuestionMessage: stream failed', {
      sessionId: opts.sessionId,
      provider: providerSlug,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    // If nothing streamed yet, emit the verbatim prompt so the respondent still gets the question.
    if (accumulated.length === 0) {
      yield { type: 'content', delta: fallback };
      return { message: fallback, costUsd: 0 };
    }
  }

  const message = accumulated.trim().length > 0 ? accumulated : fallback;
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
      metadata: { capability: 'app_phrase_question_stream', sessionId: opts.sessionId },
    }).catch((err) => {
      logger.error('streamQuestionMessage: logCost rejected', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return { message, costUsd };
}
