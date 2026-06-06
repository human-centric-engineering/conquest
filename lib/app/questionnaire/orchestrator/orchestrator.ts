/**
 * The pure per-turn orchestrator (F6.1).
 *
 * {@link runTurn} runs the deterministic pipeline over one respondent turn, chaining the
 * P4 capabilities through injected {@link CapabilityInvokers}. It is pure relative to its
 * inputs — same {@link TurnState} + same invoker outputs → same {@link TurnResult}. All
 * I/O (persistence, cost logging, the turn record, the streamed offer prose) is the
 * route's job; the core only *decides*.
 *
 * Pipeline order (a step is skipped, not failed, when its flag/config is off):
 *   1. Extract answer slots from the message (F4.2) — only with a non-empty message.
 *   2. Merge the extracted intents into an *effective* state (coverage + values) so the
 *      downstream steps see the answer just given.
 *   3. Detect contradictions over the effective answers (F4.3) — only when the config
 *      mode is not `off`.
 *   4. Refine (F4.4) — only when step 3 flagged a contradiction (the PR2 trigger).
 *   5. Assess completion (F4.5, pure) — always; free and deterministic.
 *   6. Respond — offer to submit (assessment `offer`) or select the next question (F4.1).
 */

import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import { assessCompletion } from '@/lib/app/questionnaire/completion/completion-logic';
import { unansweredQuestions } from '@/lib/app/questionnaire/selection/context';
import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { ChatEvent } from '@/types/orchestration';

import type {
  CapabilityInvokers,
  ExistingAnswerView,
  OfferComposeInput,
  ToolCallRecord,
  TurnResponse,
  TurnResult,
  TurnState,
} from '@/lib/app/questionnaire/orchestrator/types';

/** Synthetic slug recorded on a turn's `toolCalls` for the (non-capability) selection step. */
export const SELECTION_TOOL_SLUG = 'app_select_question';

/** Fewest answers a contradiction pass needs — the detector capability enforces `min(2)`. */
export const MIN_CONTRADICTION_ANSWERS = 2;

/** Deterministic fallback prose for the terminal branches (offer phrasing is the LLM's job). */
export const COMPLETE_MESSAGE =
  "Thanks — that's everything we need. You can submit your responses whenever you're ready.";
export const NONE_MESSAGE =
  "We've reached the end of the available questions. Thanks for your answers.";

/** Look up a question's display prompt; empty when the loader didn't populate it. */
function promptFor(questions: QuestionView[], questionId: string): string {
  return questions.find((q) => q.id === questionId)?.prompt ?? '';
}

/**
 * Merge this turn's extracted intents into the turn state — so completion assessment and
 * selection see the answer just given. Pure: returns a new state, mutating nothing.
 * `answered` gains the intents' questions (coverage); `existingAnswers` gains/updates
 * their values (so a later refine sees them).
 */
export function applyIntents(state: TurnState, intents: AnswerSlotIntent[]): TurnState {
  if (intents.length === 0) return state;

  const keyToQuestionId = new Map(state.questions.map((q) => [q.key, q.id]));

  const answered: AnsweredView[] = state.answered.map((a) => ({ ...a }));
  const answeredIds = new Set(answered.map((a) => a.questionId));
  const existingAnswers: ExistingAnswerView[] = state.existingAnswers.map((a) => ({ ...a }));

  for (const intent of intents) {
    const questionId = keyToQuestionId.get(intent.slotKey);
    if (questionId && !answeredIds.has(questionId)) {
      answered.push({ questionId, confidence: intent.confidence });
      answeredIds.add(questionId);
    }

    const existing = existingAnswers.find((a) => a.slotKey === intent.slotKey);
    const merged: ExistingAnswerView = {
      slotKey: intent.slotKey,
      value: intent.value,
      provenance: intent.provenance,
      confidence: intent.confidence,
      ...(intent.rationale ? { rationale: intent.rationale } : {}),
    };
    if (existing) {
      Object.assign(existing, merged);
    } else {
      existingAnswers.push(merged);
    }
  }

  return { ...state, answered, existingAnswers };
}

/** Build the streaming offer composer's input from the (effective) state + assessment. */
function buildOfferInput(
  state: TurnState,
  coverage: number,
  answeredCount: number,
  capReached: boolean
): OfferComposeInput {
  const remaining = unansweredQuestions(state);
  const remainingIds = new Set(remaining.map((q) => q.id));
  const covered = state.questions.filter((q) => !remainingIds.has(q.id));

  return {
    coverage,
    answeredCount,
    capReached,
    coveredSlots: covered.map((q) => ({ key: q.key, prompt: q.prompt ?? '' })),
    remainingSlots: remaining.map((q) => ({ key: q.key, prompt: q.prompt ?? '' })),
    recentMessages: state.recentMessages,
  };
}

/** Append a tool-call record, carrying latency/code only when present (exactOptional-safe). */
function toolCall(
  slug: string,
  success: boolean,
  opts: { code?: string; latencyMs?: number } = {}
): ToolCallRecord {
  return {
    slug,
    success,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
  };
}

export async function runTurn(state: TurnState, invokers: CapabilityInvokers): Promise<TurnResult> {
  const events: ChatEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const answerUpserts: AnswerSlotIntent[] = [];
  let answerRefinements: TurnResult['sideEffects']['answerRefinements'] = [];
  let contradictions: TurnResult['contradictions'] = [];
  let costUsd = 0;

  const hasMessage = state.userMessage.trim().length > 0;

  // 1. Extract answer slots from the message.
  if (hasMessage && state.flags.extraction) {
    const out = await invokers.extractAnswers(state);
    costUsd += out.costUsd;
    toolCalls.push(
      toolCall(EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG, out.diagnostic === undefined, {
        ...(out.diagnostic !== undefined ? { code: out.diagnostic } : {}),
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      })
    );
    answerUpserts.push(...out.intents);
    if (out.diagnostic !== undefined) {
      events.push({
        type: 'warning',
        code: out.diagnostic,
        message: "I couldn't capture an answer from that — we can revisit it.",
      });
    }
  }

  // 2. Merge the extracted intents so the rest of the pipeline sees the answer just given.
  const effective = applyIntents(state, answerUpserts);

  // 3. Detect contradictions over the effective answers. A contradiction needs ≥2 answers
  //    to compare, and the detector capability enforces that (`answers.min(2)`); skip the
  //    dispatch below that floor so an early turn doesn't surface a spurious validation
  //    warning or record a failed tool-call.
  if (
    effective.config.contradictionMode !== 'off' &&
    effective.flags.contradiction &&
    effective.existingAnswers.length >= MIN_CONTRADICTION_ANSWERS
  ) {
    const out = await invokers.detectContradictions(effective);
    costUsd += out.costUsd;
    toolCalls.push(
      toolCall(DETECT_CONTRADICTIONS_CAPABILITY_SLUG, out.diagnostic === undefined, {
        ...(out.diagnostic !== undefined ? { code: out.diagnostic } : {}),
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      })
    );
    contradictions = out.findings;
    for (const finding of out.findings) {
      events.push({
        type: 'warning',
        code: 'contradiction',
        message: finding.suggestedProbe ?? finding.explanation,
      });
    }
  }

  // 4. Refine — contradiction-driven (the PR2 trigger; clarification-only refinement is future work).
  if (contradictions.length > 0 && effective.flags.refinement) {
    const out = await invokers.refineAnswer(effective, { contradiction: contradictions[0] });
    costUsd += out.costUsd;
    toolCalls.push(
      toolCall(REFINE_ANSWER_CAPABILITY_SLUG, out.diagnostic === undefined, {
        ...(out.diagnostic !== undefined ? { code: out.diagnostic } : {}),
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      })
    );
    answerRefinements = out.decisions;
  }

  // 5. Assess completion (pure, free, always).
  const assessment = assessCompletion({
    questions: effective.questions,
    answered: effective.answered,
    config: effective.config,
    sessionId: effective.sessionId,
  });

  // 6. Respond.
  let response: TurnResponse;
  let targetedQuestionId: string | null;

  if (assessment.kind === 'offer') {
    if (effective.flags.completion) {
      // Offer turn: the route streams the composed prose; the core hands it the input.
      toolCalls.push(toolCall(COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG, true));
      response = {
        kind: 'offer',
        input: buildOfferInput(
          effective,
          assessment.coverage,
          assessment.answeredCount,
          assessment.capReached
        ),
      };
    } else {
      // Offer phrasing disabled: emit a plain completion message (gate still authoritative).
      response = { kind: 'complete', text: COMPLETE_MESSAGE };
    }
    targetedQuestionId = null;
  } else {
    // Not ready to offer — pick the next question.
    const out = await invokers.selectNext(effective);
    const decision = out.decision;
    if (decision.kind === 'ask') {
      costUsd += decision.costUsd;
    }
    toolCalls.push(
      toolCall(SELECTION_TOOL_SLUG, true, {
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      })
    );

    if (decision.kind === 'ask') {
      response = {
        kind: 'question',
        questionId: decision.questionId,
        text: promptFor(effective.questions, decision.questionId),
      };
      targetedQuestionId = decision.questionId;
    } else if (decision.kind === 'complete') {
      response = { kind: 'complete', text: COMPLETE_MESSAGE };
      targetedQuestionId = null;
    } else {
      response = { kind: 'none', text: NONE_MESSAGE };
      targetedQuestionId = null;
    }
  }

  return {
    response,
    targetedQuestionId,
    sideEffects: { answerUpserts, answerRefinements },
    events,
    toolCalls,
    costUsd,
    contradictions,
    assessment,
  };
}
