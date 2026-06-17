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
import { getTextContent, type LlmMessage } from '@/lib/orchestration/llm/types';
import type { RecordAgentCall } from '@/lib/app/questionnaire/inspector';
import {
  QUESTION_TYPE_LABELS,
  type QuestionType,
  type SensitivitySeverity,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';
import { buildToneInstructions } from '@/lib/app/questionnaire/chat/tone';
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
  /**
   * A short digest of what the respondent has already shared this session — each entry a
   * `"<label>: <summary>"` line (e.g. a data slot's name + its paraphrase). Background for
   * continuity: the interviewer may refer back to one point naturally when it genuinely helps
   * the next question flow, but must NOT recap the list or re-ask anything in it. Absent/empty
   * → the block is omitted (no behaviour change). Built by `_lib/prior-answers.ts`.
   */
  priorAnswers?: string[];
  /** The respondent's message this turn (to acknowledge); empty on the opening turn. */
  lastUserMessage: string;
  /** True when this same question was just asked and the prior answer wasn't captured. */
  isReask: boolean;
  /** True for the first question of the session (nothing to acknowledge yet). */
  isOpening: boolean;
  /**
   * How many questions/slots have already been asked this session (the selection round, 0-based).
   * Calibrates length: early questions are kept very tight (a single, effortless sentence) and may
   * grow a little warmer/fuller once rapport has built — never convoluted at any point.
   */
  questionsAsked: number;
  /**
   * Sensitivity awareness / safeguarding: the session's running-max disclosure severity, set once
   * something sensitive has been remembered. When present it switches on a "tread carefully" tone
   * for THIS and every later question (the route threads it from session memory each turn).
   */
  sensitivityLevel?: SensitivitySeverity | null;
  /**
   * The careful, non-graphic summaries of what was disclosed this session (newest folded in by the
   * route). Used to remind the interviewer what to be gentle about — never re-raised verbatim.
   */
  sensitivityNotes?: string[];
  /**
   * Data Slots feature — topic rhythm. `true` = we just moved to a NEW subject area (bridge with
   * a natural segue); `false`/absent = staying in the same area (deepen — the skilled-interviewer
   * "linger before moving on"). Only consulted on a normal acknowledge-and-ask turn.
   */
  isTransition?: boolean;
  /**
   * Move-on (Data Slots feature): on a re-ask, the agent's CURRENT (weak) understanding of the
   * slot — its paraphrase — so the follow-up gets specific about the gap instead of repeating the
   * same open question. Only consulted when `isReask`.
   */
  currentUnderstanding?: string;
  /**
   * Move-on (Data Slots feature): the LAST allowed attempt before the slot is parked and the
   * conversation moves on — frame it as a light, pressure-free final try.
   */
  isFinalAttempt?: boolean;
  /**
   * Interviewer tone & persona (F-tone): the resolved {@link ToneSettings} block the admin
   * configured. Only present when the platform tone flag is on (the route gates it); absent =
   * today's default voice. `buildToneInstructions` renders its enabled dimensions into the prompt;
   * `tone.mimicry.enabled` additionally governs whether the default "match their tone" line is kept.
   */
  tone?: ToneSettings;
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

/**
 * Best-effort integer bounds from a likert slot's config, for the explicit-scale clarifying
 * fallback. Likert `typeConfig` is `{ min, max }` (no labels array, so {@link extractOptionLabels}
 * returns nothing for it). Returns `undefined` when no usable bounds are present.
 */
export function extractLikertScale(typeConfig: unknown): { min: number; max: number } | undefined {
  if (typeConfig === null || typeof typeConfig !== 'object') return undefined;
  const { min, max } = typeConfig as Record<string, unknown>;
  if (typeof min === 'number' && typeof max === 'number' && max > min) return { min, max };
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

  // Tone & persona (F-tone): the admin-configured voice, rendered to imperative clauses. Empty
  // string when nothing is enabled (or no tone configured) — then the default voice is unchanged.
  const toneInstructions = input.tone ? buildToneInstructions(input.tone) : '';

  // Length is calibrated by how far into the conversation we are: the first few questions stay
  // very tight (effortless to answer), and later ones may be a touch warmer — but never long.
  // When the admin controls verbosity explicitly, its clause (in `toneInstructions`) governs the
  // non-opening length instead of the default "keep it concise" line — but the opening-question
  // brevity floor is always kept so the very first asks stay effortless.
  const isEarly = input.questionsAsked < 3;
  const verbosityControlled = input.tone?.verbosity.enabled === true;
  const brevity = isEarly
    ? 'This is early in the conversation, so keep it VERY short and tight — ideally a single, ' +
      'simple, easy-to-answer sentence. The opening questions must feel effortless. '
    : verbosityControlled
      ? ''
      : 'Keep your OWN question concise — one or two sentences — even as you invite a longer answer ' +
        'from them; a short, open question gives them the most room to expand. Rapport has built, ' +
        'so you may be a little warmer or add light context, but never long-winded or convoluted. ';

  // Sensitivity awareness / safeguarding: once a sensitive disclosure has been remembered this
  // session, every later question is asked more gently. The latest summary reminds the interviewer
  // what to be careful about (kept non-graphic by construction); the specifics are not re-raised.
  const lastNote = input.sensitivityNotes?.[input.sensitivityNotes.length - 1];
  const treadCarefully = input.sensitivityLevel
    ? 'IMPORTANT — earlier in this conversation the respondent shared something sensitive or ' +
      'difficult' +
      (lastNote ? ` (${lastNote})` : '') +
      '. Continue with extra care and warmth: acknowledge gently where natural, never press for ' +
      'detail they did not offer, avoid blunt or clinical phrasing, and give them room. Do not ' +
      're-raise the specifics unless they bring them up. '
    : '';

  const system =
    'You are a warm, emotionally attuned interviewer guiding someone through a questionnaire. ' +
    'You are deeply skilled in human psychology and the craft of getting people to open up — you ' +
    'understand that people share most freely when they feel genuinely heard, unhurried, and ' +
    'trusted to follow their own train of thought. Your aim is to draw out rich, reflective, ' +
    'story-led answers, not to tick boxes. ' +
    'Ask the ONE question provided, naturally — never as a numbered form field, never restate ' +
    'the whole survey, never invent new questions, and never answer on their behalf. ' +
    // The single most important rule for readable questions: one ask, stated plainly.
    'Ask about ONE thing at a time. Do NOT bundle several sub-questions into one message or ' +
    'pre-list everything you hope to learn (e.g. do not tack on "…and tell me what was good, any ' +
    'challenges, and what changed"). State the core question simply and let them answer; you can ' +
    'always draw out more on the next turn. ' +
    // Open phrasing: one ask, but framed to invite an expansive, reflective answer.
    'Phrase every question as an OPEN invitation rather than a closed prompt — favour "Tell me ' +
    'about…", "What was that like for you?", "Walk me through…", "How did you come to…" over ' +
    'anything answerable in a single word. Where it fits naturally, gently invite them to ' +
    'illustrate with a recent example or moment, and make it feel completely fine to take their ' +
    'time, think aloud, and follow a tangent if one comes to mind — reassure them, in spirit, ' +
    'that whatever they share is welcome and helpful. Ask the one thing, then leave them real ' +
    'room to be expansive. ' +
    // Phase 5 — infer scales/choices from natural language; only spell them out as a last resort.
    'When the question is a rating SCALE, ask about the underlying feeling or judgement in plain, ' +
    'everyday language and read their level from HOW they answer — unless told below that a ' +
    'clarification is needed, do NOT ask them to pick a number or recite a numeric scale. When the ' +
    'question has fixed CHOICES, ask it openly in your own words and let them answer naturally (we ' +
    'map their reply to an option for them) — unless told below, do NOT read out the list of ' +
    'options. ' +
    (input.isOpening
      ? 'This is the very first message of the conversation — be proactive and set the scene. ' +
        'Open with a short, warm scene-setting line ("Let\'s start by…", "To begin, we\'ll explore…") ' +
        'and then ease straight into this first question gently with a single, light, easy-to-answer ' +
        'ask. There is no prior answer to acknowledge. Do not tell them to "send a message to ' +
        'begin" — you are starting the conversation. '
      : input.isReask
        ? 'You already asked about this but could not capture a usable answer from their last ' +
          'reply. ' +
          (input.currentUnderstanding
            ? `So far you understand: "${input.currentUnderstanding}". Do NOT repeat the same broad ` +
              'question — ask a SHARPER, narrower follow-up that targets the specific piece still ' +
              'missing. '
            : 'Gently say you want to make sure you get it right, then ask again clearly, more ' +
              'specifically than before. ') +
          (input.isFinalAttempt
            ? "This is a last, light try on this topic — keep it pressure-free; if they still can't " +
              "say, that's completely fine and you'll move on. "
            : '')
        : input.isTransition
          ? 'Briefly acknowledge what they just said, then bridge naturally into a NEW area and ' +
            'ask about it — like a skilled interviewer changing subject without it feeling abrupt. '
          : 'Briefly acknowledge what they just said, then ask the next question — stay in the ' +
            'same subject area and let their answer lead naturally into it (deepen before moving on). ' +
            'If their last answer was brief or surface-level, do not move on or pile on more ' +
            'questions: gently invite them to say a little more about what they just shared, with ' +
            'ONE light follow-up ("What made you say that?", "Can you give an example?"). ') +
    (input.goal ? `Questionnaire goal: ${input.goal}. ` : '') +
    (calibration.length > 0 ? calibration.join(' ') + ' ' : '') +
    treadCarefully +
    // Tone & persona clauses (when configured) are more specific than the defaults above and come
    // later, so they govern. Mimicry, when enabled, owns tone-matching — so the default
    // "match their tone" line is dropped only then; otherwise it stays as the gentle baseline.
    (toneInstructions ? toneInstructions + ' ' : '') +
    (input.tone?.mimicry.enabled ? '' : 'Match the respondent’s tone. ') +
    brevity +
    'Reply with conversational prose only: no JSON, no lists, no headings, no preamble, no quotation marks. ' +
    // Markdown bold IS rendered in the chat UI. Used sparingly it helps the respondent see the
    // single thing being asked at a glance; overused it reads as shouty, so cap it hard.
    'You may use Markdown **bold** sparingly — at most one short phrase per message — to gently ' +
    'emphasise the specific area of focus you are asking about (e.g. **recommend the workplace**). ' +
    'Never bold a whole sentence, never bold more than one phrase, and skip it entirely when no ' +
    'single phrase is the clear focus.';

  const options = extractOptionLabels(input.typeConfig);
  const likertScale = extractLikertScale(input.typeConfig);
  const transcript = input.recentMessages.slice(-6).join('\n');

  // Phase 5 — only spell out the choices/scale when we're STRUGGLING (a re-ask after the prior
  // answer wasn't captured). On the first ask, the standing rules keep it open and we infer.
  const clarifyGuidance = !input.isReask
    ? ''
    : options
      ? `\n\nThe last reply wasn't clear enough to map, so this time you MAY gently offer the choices to make it easy: ${options.join(', ')}.`
      : likertScale
        ? `\n\nThe last reply wasn't clear enough to map, so this time you MAY offer the simple ${likertScale.min}–${likertScale.max} scale (where ${likertScale.max} is the most positive) to make it easy.`
        : '';

  // What they've already shared this session (continuity). Explicitly background-only: the
  // interviewer may glance back at one point when it helps, but must not recap or re-ask it.
  const priorContext =
    input.priorAnswers && input.priorAnswers.length > 0
      ? `\n\nWhat they have already shared this session (background only — do NOT recap this list and do NOT re-ask anything in it; you MAY refer back to ONE point naturally if it genuinely helps this question land):\n${input.priorAnswers
          .map((p) => `- ${p}`)
          .join('\n')}`
      : '';

  const user =
    `The question to ask (type: ${QUESTION_TYPE_LABELS[input.type]}):\n"${input.prompt}"` +
    clarifyGuidance +
    (input.guidelines
      ? `\n\nAnswer guidance (for you, do not read aloud): ${input.guidelines}`
      : '') +
    priorContext +
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
  /** Preview Turn Inspector (admin-only): records this phrasing call's trace when supplied. */
  recordInspectorCall?: RecordAgentCall;
}): AsyncGenerator<ChatEvent, StreamedQuestion, undefined> {
  const startedAt = Date.now();
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

  if (opts.recordInspectorCall) {
    opts.recordInspectorCall({
      label: 'Interviewer phrasing',
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
