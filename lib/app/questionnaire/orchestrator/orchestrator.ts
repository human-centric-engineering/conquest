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
import { shouldRunDetection } from '@/lib/app/questionnaire/contradiction';
import { evaluateAbuseStrike, ABUSE_ABANDON_MESSAGE } from '@/lib/app/questionnaire/seriousness';
import {
  runningMaxLevel,
  shouldSignpost,
  composeSupportMessage,
} from '@/lib/app/questionnaire/sensitivity';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';
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

/** Synthetic slug recorded on a turn's `toolCalls` for the seriousness-judge step. */
export const ASSESS_SERIOUSNESS_TOOL_SLUG = 'app_assess_seriousness';

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
  capReached: boolean,
  costWrapUp: boolean
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
    ...(costWrapUp ? { costWrapUp: true } : {}),
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
  // Sensitivity awareness: the extractor's disclosure assessment this turn, captured for step 1.6.
  let extractedSensitivity: SensitivityAssessment | undefined;

  // 1. Extract answer slots from the message. The extractor also emits a `suspectedNonGenuine`
  //    hint, but it proved an unreliable GATE (an optional flag the model often omits even for
  //    blatant abuse) — so it is no longer what decides whether the judge runs; see 1.5.
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
    extractedSensitivity = out.sensitivity;
    if (out.diagnostic !== undefined) {
      events.push({
        type: 'warning',
        code: out.diagnostic,
        message: "I couldn't capture an answer from that — we can revisit it.",
      });
    }
  }

  // 1.5 Seriousness / abuse gate. The judge runs on EVERY answered turn while the gate is on and
  //     the questionnaire tolerates a finite number of strikes — a dedicated, cheap LLM call, so we
  //     don't depend on the extractor's (unreliable) suspicion flag to trigger it. A non-serious
  //     verdict DISREGARDS the answer (never merged/persisted), strikes the session, and escalates
  //     → abandon at the configured threshold. A genuine answer (incl. colloquial/lazy) passes.
  let abuse: TurnResult['abuse'];
  let disregarded = false;
  if (hasMessage && state.flags.seriousnessGate && state.config.abuseThreshold > 0) {
    const judged = await invokers.assessSeriousness(state);
    costUsd += judged.costUsd;
    toolCalls.push(
      toolCall(ASSESS_SERIOUSNESS_TOOL_SLUG, judged.diagnostic === undefined, {
        ...(judged.diagnostic !== undefined ? { code: judged.diagnostic } : {}),
        ...(judged.latencyMs !== undefined ? { latencyMs: judged.latencyMs } : {}),
      })
    );
    if (judged.verdict && !judged.verdict.serious) {
      // Disregard — a non-genuine answer is never merged or persisted.
      disregarded = true;
      answerUpserts.length = 0;
      const strike = evaluateAbuseStrike(state.abuseStrikes, state.config.abuseThreshold);
      abuse = {
        flagged: true,
        newStrikeCount: strike.newStrikeCount,
        abandon: strike.abandon,
        reason: judged.verdict.reason,
      };
      if (strike.abandon) {
        // Terminal: stream a polite final message; the route abandons the session + emits the
        // terminal frame. Skip the rest of the pipeline (no detect / refine / select). The
        // assessment reflects the UNCHANGED state (the bogus answer was dropped).
        return {
          response: { kind: 'complete', text: strike.abandonMessage ?? ABUSE_ABANDON_MESSAGE },
          targetedQuestionId: null,
          sideEffects: { answerUpserts: [], answerRefinements: [] },
          // Drop any side-band notice (e.g. the extraction "couldn't capture that" diagnostic) —
          // on a terminal turn the abandon message is the only thing the respondent should see.
          events: [],
          toolCalls,
          costUsd,
          contradictions: [],
          assessment: assessCompletion({
            questions: state.questions,
            answered: state.answered,
            config: state.config,
            sessionId: state.sessionId,
          }),
          abuse,
        };
      }
      // Below threshold: surface the escalating notice; the pipeline re-asks the same
      // (still-unanswered) question because the answer was not merged.
      events.push({ type: 'warning', code: 'seriousness', message: strike.noticeMessage });
    }
  }

  // 1.6 Sensitivity awareness / safeguarding. When the extractor flagged a genuine disclosure (and
  //     the turn wasn't disregarded as non-genuine), remember it: compute the session's running-max
  //     level, decide whether to signpost support (first time it reaches `high`), and return the
  //     outcome for the route to persist. Tone-softening itself happens in the phraser, which reads
  //     the persisted notes every later turn. The support frame is pushed LAST (below) so it wins
  //     the chat's single notice slot over any other warning this turn.
  let sensitivity: TurnResult['sensitivity'];
  if (hasMessage && state.flags.sensitivityAwareness && !disregarded && extractedSensitivity) {
    sensitivity = {
      detected: true,
      severity: extractedSensitivity.severity,
      category: extractedSensitivity.category,
      summary: extractedSensitivity.summary,
      newLevel: runningMaxLevel(state.sensitivityLevel, extractedSensitivity.severity),
      signpost: shouldSignpost(state.sensitivityLevel, extractedSensitivity.severity),
    };
  }

  // 2. Merge the extracted intents so the rest of the pipeline sees the answer just given.
  const effective = applyIntents(state, answerUpserts);

  // 3. Detect contradictions over the effective answers. A contradiction needs ≥2 answers
  //    to compare, and the detector capability enforces that (`answers.min(2)`); skip the
  //    dispatch below that floor so an early turn doesn't surface a spurious validation
  //    warning or record a failed tool-call.
  // `shouldRunDetection` folds in the mode (off → never) AND the `every_n_turns`
  // cadence (run only on a turn boundary); `selectionRound` is the zero-based turn index.
  const detection = shouldRunDetection(
    effective.config.contradictionMode,
    effective.config.contradictionWindowN,
    'turn',
    {
      everyNTurns: effective.config.contradictionEveryNTurns,
      turnIndex: effective.selectionRound,
    }
  );
  if (
    detection.run &&
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

  // Soft cost cap (F6.3): bias toward offering completion early so the session winds down
  // before the hard cap, and tag the offer prose with a wrap-up instruction. Only overrides
  // `not_ready` (thresholds merely unmet) — never the required-questions gate
  // (`blocked_on_required` stays authoritative), and never an empty session (answeredCount 0).
  const costWrapUp = effective.costPressure === 'soft';
  const offerEarly = costWrapUp && assessment.kind === 'not_ready' && assessment.answeredCount > 0;

  // 6. Respond.
  let response: TurnResponse;
  let targetedQuestionId: string | null;
  // Captured for the "watch it think" reasoning trace — the selector's flow rationale, otherwise
  // dropped after the response is built. Only set on a `question` turn (an offer/complete/none turn
  // selected nothing). See `lib/app/questionnaire/reasoning`.
  let selectionRationale: string | undefined;

  if (assessment.kind === 'offer' || offerEarly) {
    if (effective.flags.completion) {
      // Offer turn: the route streams the composed prose; the core hands it the input.
      toolCalls.push(toolCall(COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG, true));
      response = {
        kind: 'offer',
        input: buildOfferInput(
          effective,
          assessment.coverage,
          assessment.answeredCount,
          assessment.capReached,
          costWrapUp
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
      selectionRationale = decision.rationale;
    } else if (decision.kind === 'complete') {
      response = { kind: 'complete', text: COMPLETE_MESSAGE };
      targetedQuestionId = null;
    } else {
      response = { kind: 'none', text: NONE_MESSAGE };
      targetedQuestionId = null;
    }
  }

  // Signpost support LAST so it wins the chat's single notice slot (the hook keeps one warning).
  // Only when a serious disclosure was first reached this turn AND the admin authored copy.
  if (sensitivity?.signpost && state.config.supportMessage.trim().length > 0) {
    events.push({
      type: 'warning',
      code: 'support',
      message: composeSupportMessage(state.config.supportMessage, state.config.supportResourceUrl),
    });
  }

  return {
    response,
    targetedQuestionId,
    ...(selectionRationale !== undefined ? { selectionRationale } : {}),
    selectionStrategy: state.config.selectionStrategy,
    sideEffects: { answerUpserts, answerRefinements },
    events,
    toolCalls,
    costUsd,
    contradictions,
    assessment,
    ...(abuse !== undefined ? { abuse } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
  };
}
