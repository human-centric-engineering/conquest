/**
 * The per-turn orchestrator for DATA-SLOT MODE (Data Slots feature).
 *
 * A parallel to {@link runTurn} used when a launched version has data slots and the feature is
 * on. The conversation targets DATA SLOTS (short semantic targets) naturally — an empathetic,
 * skilled-interviewer rhythm — while the underlying QUESTIONS fill in the background as the
 * deliverable. Pure, like {@link runTurn}: reads a {@link TurnState} (with `dataSlots`) and an
 * injected {@link CapabilityInvokers}, returns a {@link TurnResult}. The route does the I/O.
 *
 * Pipeline:
 *   1. Extract (ONE combined call) — question answers (background) + data-slot fills (facing).
 *   2. Merge both into effective state.
 *   3. Respond:
 *      - all questions answered → offer to submit (or complete when phrasing is off);
 *      - else an unfilled data slot remains → target the next one, **topic-local** (stay in the
 *        current theme, lingering to fill an area before moving on);
 *      - else (every slot filled but a question is still open) → **sweep**: ask the next
 *        unanswered question directly.
 *
 * Contradiction/refinement (F4.3/F4.4) are intentionally not run in data-slot mode v1 — the
 * combined extractor already improves fills/answers each turn; reconciliation is future work.
 */

import { EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import {
  applyIntents,
  ASSESS_SERIOUSNESS_TOOL_SLUG,
} from '@/lib/app/questionnaire/orchestrator/orchestrator';
import { evaluateAbuseStrike, ABUSE_ABANDON_MESSAGE } from '@/lib/app/questionnaire/seriousness';
import { unansweredQuestions } from '@/lib/app/questionnaire/selection/context';
import type { ChatEvent } from '@/types/orchestration';
import type {
  AnswerSlotIntent,
  DataSlotFillIntent,
} from '@/lib/app/questionnaire/extraction/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';

import type {
  CapabilityInvokers,
  DataSlotAnsweredView,
  DataSlotTarget,
  OfferComposeInput,
  ToolCallRecord,
  TurnResponse,
  TurnResult,
  TurnState,
} from '@/lib/app/questionnaire/orchestrator/types';

/** Synthetic slug recorded on a turn's `toolCalls` for the data-slot selection step. */
export const DATA_SLOT_SELECTION_TOOL_SLUG = 'app_select_data_slot';

/** Confidence at/above which a data slot counts as "filled" for targeting + the panel. */
export const DATA_SLOT_FILLED_THRESHOLD = 0.5;

/** Deterministic fallback prose for the terminal branches (offer phrasing is the LLM's job). */
export const DATA_SLOT_COMPLETE_MESSAGE =
  "Thanks — that's everything we need. You can submit your responses whenever you're ready.";

/** Merge this turn's data-slot fills into the answered set (filled = confidence ≥ threshold). */
function applyFills(
  dataSlots: DataSlotTarget[],
  answered: DataSlotAnsweredView[],
  fills: DataSlotFillIntent[]
): DataSlotAnsweredView[] {
  if (fills.length === 0) return answered;
  const idByKey = new Map(dataSlots.map((s) => [s.key, s.id]));
  const byId = new Map(answered.map((a) => [a.dataSlotId, { ...a }]));
  for (const fill of fills) {
    const id = idByKey.get(fill.dataSlotKey);
    if (!id) continue;
    byId.set(id, { dataSlotId: id, confidence: fill.confidence });
  }
  return [...byId.values()];
}

/** The unfilled data slots, theme-ordered (the loader already orders by theme then ordinal). */
function unfilledDataSlots(
  dataSlots: DataSlotTarget[],
  answered: DataSlotAnsweredView[]
): DataSlotTarget[] {
  const filled = new Set(
    answered
      .filter((a) => (a.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD)
      .map((a) => a.dataSlotId)
  );
  return dataSlots.filter((s) => !filled.has(s.id));
}

/**
 * Topic-local pick: prefer an unfilled slot in the CURRENT theme (the one the previous turn
 * targeted) so the interviewer lingers in an area; only when that area is exhausted move to the
 * next theme. Falls back to the first unfilled slot when there's no active theme.
 */
function pickNextDataSlot(
  unfilled: DataSlotTarget[],
  activeDataSlotKey: string | null | undefined,
  dataSlots: DataSlotTarget[]
): DataSlotTarget {
  const activeTheme = activeDataSlotKey
    ? dataSlots.find((s) => s.key === activeDataSlotKey)?.theme
    : undefined;
  if (activeTheme) {
    const sameTheme = unfilled.find((s) => s.theme === activeTheme);
    if (sameTheme) return sameTheme;
  }
  return unfilled[0];
}

/** Build the offer composer's input from the filled data slots (the topics covered). */
function buildOfferInput(
  state: TurnState,
  dataSlots: DataSlotTarget[],
  answered: DataSlotAnsweredView[],
  answeredQuestionCount: number
): OfferComposeInput {
  const filled = new Set(
    answered
      .filter((a) => (a.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD)
      .map((a) => a.dataSlotId)
  );
  return {
    coverage: 1,
    answeredCount: answeredQuestionCount,
    capReached: false,
    coveredSlots: dataSlots
      .filter((s) => filled.has(s.id))
      .map((s) => ({ key: s.key, prompt: s.name })),
    remainingSlots: [],
    recentMessages: state.recentMessages,
    ...(state.costPressure === 'soft' ? { costWrapUp: true } : {}),
  };
}

function toolCall(
  slug: string,
  success: boolean,
  opts: { latencyMs?: number } = {}
): ToolCallRecord {
  return { slug, success, ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}) };
}

/** Run one data-slot-mode turn. Mirrors {@link runTurn}'s shape; targets data slots. */
export async function runDataSlotTurn(
  state: TurnState,
  invokers: CapabilityInvokers
): Promise<TurnResult> {
  const dataSlots = state.dataSlots ?? [];
  const events: ChatEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const answerUpserts: AnswerSlotIntent[] = [];
  let dataSlotFills: DataSlotFillIntent[] = [];
  let costUsd = 0;

  const hasMessage = state.userMessage.trim().length > 0;

  // 1. Combined extraction — question answers (background) + data-slot fills (respondent-facing).
  if (hasMessage && state.flags.extraction) {
    const out = await invokers.extractAnswers(state);
    costUsd += out.costUsd;
    toolCalls.push(
      toolCall(EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG, out.diagnostic === undefined, {
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      })
    );
    answerUpserts.push(...out.intents);
    dataSlotFills = out.dataSlotFills ?? [];
    if (out.diagnostic !== undefined) {
      events.push({
        type: 'warning',
        code: out.diagnostic,
        message: "I couldn't quite capture that — let's keep going.",
      });
    }
  }

  // 1.5 Seriousness / abuse gate (parity with question mode). The judge runs on every answered
  //     turn while the gate is on; a non-serious verdict DISREGARDS both this turn's question
  //     answers AND its data-slot fills (never persisted), strikes the session, and abandons at the
  //     configured threshold.
  let abuse: TurnResult['abuse'];
  if (hasMessage && state.flags.seriousnessGate && state.config.abuseThreshold > 0) {
    const judged = await invokers.assessSeriousness(state);
    costUsd += judged.costUsd;
    toolCalls.push(
      toolCall(ASSESS_SERIOUSNESS_TOOL_SLUG, judged.diagnostic === undefined, {
        ...(judged.latencyMs !== undefined ? { latencyMs: judged.latencyMs } : {}),
      })
    );
    if (judged.verdict && !judged.verdict.serious) {
      // Disregard — neither the question answers nor the data-slot fills are kept.
      answerUpserts.length = 0;
      dataSlotFills = [];
      const strike = evaluateAbuseStrike(state.abuseStrikes, state.config.abuseThreshold);
      abuse = {
        flagged: true,
        newStrikeCount: strike.newStrikeCount,
        abandon: strike.abandon,
        reason: judged.verdict.reason,
      };
      if (strike.abandon) {
        // Terminal: the route abandons the session + locks the surface. The assessment reflects
        // the UNCHANGED background question coverage (the dropped answers were never merged).
        const answeredAtAbandon = new Set(state.answered.map((a) => a.questionId));
        return {
          response: { kind: 'complete', text: strike.abandonMessage ?? ABUSE_ABANDON_MESSAGE },
          targetedQuestionId: null,
          sideEffects: { answerUpserts: [], answerRefinements: [], dataSlotFills: [] },
          events,
          toolCalls,
          costUsd,
          contradictions: [],
          assessment: {
            kind: 'not_ready',
            coverage:
              state.questions.length === 0 ? 1 : answeredAtAbandon.size / state.questions.length,
            answeredCount: answeredAtAbandon.size,
            requiredUnansweredKeys: [],
            capReached: false,
            unmet: ['coverage_below_threshold'],
            rationale: 'Session abandoned by the seriousness gate.',
          },
          abuse,
        };
      }
      // Below threshold: surface the escalating notice; the conversation re-targets below because
      // the fills were not merged (the data slot stays unfilled).
      events.push({ type: 'warning', code: 'seriousness', message: strike.noticeMessage });
    }
  }

  // 2. Merge — so targeting + completion see this turn's fills/answers.
  const effective = applyIntents(state, answerUpserts);
  const effectiveDataAnswered = applyFills(dataSlots, state.dataSlotAnswered ?? [], dataSlotFills);

  // Background deliverable: completion is gated on ALL questions being answered.
  const answeredIds = new Set(effective.answered.map((a) => a.questionId));
  const remainingQuestions = unansweredQuestions({
    questions: effective.questions,
    answered: effective.answered,
  });
  const allQuestionsAnswered = remainingQuestions.length === 0 && effective.questions.length > 0;

  // The progress/assessment the route persists + the panel reads (question coverage).
  const assessment: CompletionAssessment = {
    kind: allQuestionsAnswered ? 'offer' : 'not_ready',
    coverage: effective.questions.length === 0 ? 1 : answeredIds.size / effective.questions.length,
    answeredCount: answeredIds.size,
    requiredUnansweredKeys: [],
    capReached: false,
    unmet: allQuestionsAnswered ? [] : ['coverage_below_threshold'],
    rationale: allQuestionsAnswered
      ? 'All questions answered; ready to submit.'
      : `${remainingQuestions.length} question(s) still unanswered.`,
  };

  // 3. Respond.
  let response: TurnResponse;
  let targetedQuestionId: string | null = null;

  const unfilled = unfilledDataSlots(dataSlots, effectiveDataAnswered);

  if (allQuestionsAnswered) {
    if (effective.flags.completion) {
      response = {
        kind: 'offer',
        input: buildOfferInput(effective, dataSlots, effectiveDataAnswered, answeredIds.size),
      };
    } else {
      response = { kind: 'complete', text: DATA_SLOT_COMPLETE_MESSAGE };
    }
  } else if (unfilled.length > 0) {
    // Target the next data slot, topic-local (linger in the current theme).
    const next = pickNextDataSlot(unfilled, state.activeDataSlotKey, dataSlots);
    const activeTheme = state.activeDataSlotKey
      ? dataSlots.find((s) => s.key === state.activeDataSlotKey)?.theme
      : undefined;
    toolCalls.push(toolCall(DATA_SLOT_SELECTION_TOOL_SLUG, true));
    response = {
      kind: 'data_slot',
      dataSlotId: next.id,
      dataSlotKey: next.key,
      name: next.name,
      description: next.description,
      theme: next.theme,
      isReask: next.key === state.activeDataSlotKey,
      isTransition: activeTheme !== undefined && activeTheme !== next.theme,
    };
  } else {
    // Every data slot is filled, but a background question is still open → ask it directly.
    const next = remainingQuestions[0];
    toolCalls.push(toolCall(DATA_SLOT_SELECTION_TOOL_SLUG, true));
    response = { kind: 'question', questionId: next.id, text: next.prompt ?? '' };
    targetedQuestionId = next.id;
  }

  return {
    response,
    targetedQuestionId,
    sideEffects: { answerUpserts, answerRefinements: [], dataSlotFills },
    events,
    toolCalls,
    costUsd,
    contradictions: [],
    assessment,
    ...(abuse !== undefined ? { abuse } : {}),
  };
}
