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
 * Contradiction detection (F4.3) + refinement (F4.4) run here too, in parity with {@link runTurn}
 * (steps 2.6/2.7): gated by the questionnaire's `contradictionMode` + cadence and the platform flag,
 * they compare the background question answers — and the respondent's latest message — so a same-slot
 * reversal across turns surfaces a `contradiction` warning (and, under `probe` mode, a reconciliation
 * question). The conflicting question answer is refined; the data-slot fill reconciles as the
 * respondent answers the probe.
 */

import { EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import {
  applyIntents,
  ASSESS_SERIOUSNESS_TOOL_SLUG,
  DETECT_SENSITIVITY_TOOL_SLUG,
} from '@/lib/app/questionnaire/orchestrator/orchestrator';
import {
  runContradictionPhase,
  questionProbeLabels,
} from '@/lib/app/questionnaire/orchestrator/contradiction-phase';
import {
  evaluateAbuseStrike,
  keywordAbuseFloor,
  ABUSE_ABANDON_MESSAGE,
} from '@/lib/app/questionnaire/seriousness';
import {
  runningMaxLevel,
  shouldSignpost,
  mergeSensitivitySignals,
  keywordSensitivityFloor,
  composeSupportMessage,
  effectiveSupportMessage,
} from '@/lib/app/questionnaire/sensitivity';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';
import { coverageRatio, unansweredQuestions } from '@/lib/app/questionnaire/selection/context';
import type { ChatEvent } from '@/types/orchestration';
import type {
  AnswerSlotIntent,
  DataSlotFillIntent,
} from '@/lib/app/questionnaire/extraction/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';
import { isEarlyFinishAvailable } from '@/lib/app/questionnaire/completion/completion-logic';

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

/**
 * Confidence stamped on a synthesised provisional fill when a slot is parked and the extractor
 * returned nothing for it — low (below the filled threshold) so the panel shows it as a tentative
 * reading, while the `provisional` flag still marks the slot covered so it isn't re-asked.
 */
export const PROVISIONAL_FLOOR_CONFIDENCE = 0.2;

/**
 * How far data-slot coverage may run ahead of the BACKGROUND question coverage before the loop
 * stops deepening the conversation and asks an unanswered REQUIRED question directly. Keeps the
 * deliverable (the questions) in step with the data-slot conversation, so mandatory answers the
 * free-flowing chat didn't capture get surfaced mid-stream — not saved for the end-of-run sweep.
 */
export const BALANCED_QUESTION_LAG = 0.2;

/** Deterministic fallback prose for the terminal branches (offer phrasing is the LLM's job). */
export const DATA_SLOT_COMPLETE_MESSAGE =
  "Thanks — that's everything we need. You can submit your responses whenever you're ready.";

/**
 * Merge this turn's data-slot fills into the answered set. A slot counts as covered at
 * confidence ≥ threshold OR when its fill is `provisional` (a parked best-effort inference). The
 * `provisional` flag is carried so targeting can exclude parked slots and the panel can mark them.
 */
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
    byId.set(id, {
      dataSlotId: id,
      confidence: fill.confidence,
      // Carry provenance so coverage can honour a STATED answer regardless of the confidence
      // number — see `isCovered`. A direct fill is never parked, so it carries no provisional flag.
      provenance: fill.provenance,
      provisional: fill.provisional ?? false,
    });
  }
  return [...byId.values()];
}

/**
 * True once a slot is "covered" for targeting — so it is neither re-asked nor parked. Covered when:
 * the respondent plainly STATED a position (`direct`), OR the fill cleared the confidence threshold,
 * OR it was already parked (provisional). The `direct` clause is deliberate: a clearly-stated answer
 * is answered even when the extractor under-scores its confidence, so a noisy number can never make a
 * real answer read as missing (the bug that re-asked "extremely unlikely" and parked it provisional).
 */
function isCovered(a: DataSlotAnsweredView): boolean {
  return (
    a.provenance === 'direct' ||
    (a.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD ||
    a.provisional === true
  );
}

/** The unfilled data slots, theme-ordered (the loader already orders by theme then ordinal). */
function unfilledDataSlots(
  dataSlots: DataSlotTarget[],
  answered: DataSlotAnsweredView[]
): DataSlotTarget[] {
  const covered = new Set(answered.filter(isCovered).map((a) => a.dataSlotId));
  return dataSlots.filter((s) => !covered.has(s.id));
}

/**
 * Topic-local pick: prefer an unfilled slot in the CURRENT theme (the one the previous turn
 * targeted) so the interviewer lingers in an area; only when that area is exhausted move to the
 * next theme. Falls back to the first unfilled slot when there's no active theme. When `avoidTheme`
 * is set (we just PARKED a slot and want to bridge to a fresh topic), prefer a slot in a DIFFERENT
 * theme — explicit forward movement instead of lingering on the area we just gave up on.
 */
function pickNextDataSlot(
  unfilled: DataSlotTarget[],
  activeDataSlotKey: string | null | undefined,
  dataSlots: DataSlotTarget[],
  avoidTheme?: string
): DataSlotTarget {
  if (avoidTheme) {
    const elsewhere = unfilled.find((s) => s.theme !== avoidTheme);
    if (elsewhere) return elsewhere;
    // Only the just-parked theme remains — fall through (still better to keep asking than stall).
  }
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
      // A genuinely-captured topic for the wrap-up summary: a stated (`direct`) fill or one that
      // cleared the threshold, but never a provisional park (a best-effort guess, not a real answer).
      .filter(
        (a) =>
          !a.provisional &&
          (a.provenance === 'direct' || (a.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD)
      )
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
  opts: { code?: string; latencyMs?: number } = {}
): ToolCallRecord {
  return {
    slug,
    success,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
  };
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
  let contradictions: TurnResult['contradictions'] = [];
  let answerRefinements: TurnResult['sideEffects']['answerRefinements'] = [];
  let costUsd = 0;

  const hasMessage = state.userMessage.trim().length > 0;
  // Sensitivity awareness: the extractor's disclosure assessment this turn, captured for step 1.6.
  let extractedSensitivity: SensitivityAssessment | undefined;

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
    extractedSensitivity = out.sensitivity;
    if (out.diagnostic !== undefined) {
      events.push({
        type: 'warning',
        code: out.diagnostic,
        message: "I couldn't quite capture that — let's keep going.",
      });
    }
  }

  // 1.4 Sensitivity detection (safeguarding), parity with question mode. The extractor's optional
  //     `sensitivity` field gets dropped non-deterministically on busy turns, so when the feature is
  //     on we ALSO run a dedicated detector AND a deterministic keyword floor and merge all three
  //     (strongest signal wins). Runs before the gate so its `!extractedSensitivity` guard sees the
  //     combined result — a genuine disclosure is never judged for sincerity or struck.
  if (hasMessage && state.flags.sensitivityAwareness) {
    const detected = await invokers.detectSensitivity(state);
    costUsd += detected.costUsd;
    toolCalls.push(
      toolCall(DETECT_SENSITIVITY_TOOL_SLUG, detected.diagnostic === undefined, {
        ...(detected.diagnostic !== undefined ? { code: detected.diagnostic } : {}),
        ...(detected.latencyMs !== undefined ? { latencyMs: detected.latencyMs } : {}),
      })
    );
    extractedSensitivity = mergeSensitivitySignals(
      extractedSensitivity,
      detected.assessment,
      keywordSensitivityFloor(state.userMessage)
    );
  }

  // 1.5 Seriousness / abuse gate (parity with question mode). Two layers: (a) a DETERMINISTIC abuse
  //     floor (`keywordAbuseFloor`) strikes a short, clearly-abusive dismissal without the judge —
  //     reliable even with a prior disclosure in context, and suppressed only by the deterministic
  //     HARM floor so a real disclosure with venting stays protected; (b) the LLM judge for nuanced
  //     cases, run only when the turn wasn't deterministically abusive AND wasn't flagged a genuine
  //     disclosure (`!extractedSensitivity`) — safeguarding outranks the sincerity gate. A non-serious
  //     outcome DISREGARDS both this turn's question answers AND its data-slot fills (never
  //     persisted), strikes the session, and abandons at the configured threshold.
  let abuse: TurnResult['abuse'];
  let disregarded = false;
  if (hasMessage && state.flags.seriousnessGate && state.config.abuseThreshold > 0) {
    const ruleAbuse = keywordAbuseFloor(state.userMessage);
    const harmFloor = keywordSensitivityFloor(state.userMessage);

    let nonSeriousReason: string | null = null;
    if (ruleAbuse && !harmFloor) {
      // Deterministic strike — no LLM call; overrides any LLM sensitivity false-positive.
      nonSeriousReason = ruleAbuse.reason;
      toolCalls.push(toolCall(ASSESS_SERIOUSNESS_TOOL_SLUG, true));
    } else if (!extractedSensitivity) {
      const judged = await invokers.assessSeriousness(state);
      costUsd += judged.costUsd;
      toolCalls.push(
        toolCall(ASSESS_SERIOUSNESS_TOOL_SLUG, judged.diagnostic === undefined, {
          ...(judged.latencyMs !== undefined ? { latencyMs: judged.latencyMs } : {}),
        })
      );
      if (judged.verdict && !judged.verdict.serious) nonSeriousReason = judged.verdict.reason;
    }

    if (nonSeriousReason !== null) {
      // Disregard — neither the question answers nor the data-slot fills are kept.
      disregarded = true;
      answerUpserts.length = 0;
      dataSlotFills = [];
      const strike = evaluateAbuseStrike(state.abuseStrikes, state.config.abuseThreshold);
      abuse = {
        flagged: true,
        newStrikeCount: strike.newStrikeCount,
        abandon: strike.abandon,
        reason: nonSeriousReason,
      };
      if (strike.abandon) {
        // Terminal: the route abandons the session + locks the surface. The assessment reflects
        // the UNCHANGED background question coverage (the dropped answers were never merged).
        const answeredAtAbandon = new Set(state.answered.map((a) => a.questionId));
        return {
          response: { kind: 'complete', text: strike.abandonMessage ?? ABUSE_ABANDON_MESSAGE },
          targetedQuestionId: null,
          sideEffects: { answerUpserts: [], answerRefinements: [], dataSlotFills: [] },
          // Drop any side-band notice (e.g. the extraction "couldn't capture that" diagnostic) —
          // on a terminal turn the abandon message is the only thing the respondent should see.
          events: [],
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
            // Abandoned by the gate — the escape hatch is moot on a terminal turn.
            earlyFinishAvailable: false,
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

  // 1.6 Sensitivity awareness / safeguarding (parity with question mode). Remember a genuine
  //     disclosure flagged by the extractor (when the turn wasn't disregarded); the route persists
  //     the running-max level + note and the phraser softens every later turn. Support frame pushed
  //     last (below).
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

  // 2. Merge — so targeting + completion see this turn's fills/answers.
  const effective = applyIntents(state, answerUpserts);
  let effectiveDataAnswered = applyFills(dataSlots, state.dataSlotAnswered ?? [], dataSlotFills);

  // 2.5 Move-on / park: when the active slot has been asked `maxDataSlotAttempts` times and is
  //     STILL unfilled, stop re-asking it — record a best-effort PROVISIONAL fill (so it reads as
  //     covered and the respondent keeps moving) and bridge to a fresh topic. Never on a
  //     disregarded (abusive) turn — the gate already cleared the fills there. The extractor was
  //     asked to infer this slot this turn (`parkPending`); if it returned nothing, synthesise a
  //     floor fill so progress is guaranteed regardless of model compliance.
  const activeSlot = state.activeDataSlotKey
    ? dataSlots.find((s) => s.key === state.activeDataSlotKey)
    : undefined;
  let parkedTheme: string | undefined;
  if (
    hasMessage &&
    !disregarded &&
    activeSlot !== undefined &&
    (state.dataSlotAttempts?.[activeSlot.id] ?? 0) >= state.config.maxDataSlotAttempts
  ) {
    const merged = effectiveDataAnswered.find((a) => a.dataSlotId === activeSlot.id);
    if (merged === undefined || !isCovered(merged)) {
      const inferred = dataSlotFills.find((f) => f.dataSlotKey === activeSlot.key);
      if (inferred) {
        inferred.provisional = true;
      } else {
        const prior = (state.dataSlotAnswered ?? []).find((a) => a.dataSlotId === activeSlot.id);
        dataSlotFills.push({
          dataSlotKey: activeSlot.key,
          value: prior?.value ?? null,
          paraphrase:
            prior?.paraphrase && prior.paraphrase.trim().length > 0
              ? prior.paraphrase
              : 'Not clearly answered yet — recorded a tentative reading to revisit.',
          confidence: PROVISIONAL_FLOOR_CONFIDENCE,
          provenance: 'inferred',
          provisional: true,
          rationale: 'Parked after the re-ask limit; best-effort placeholder to keep moving.',
        });
      }
      parkedTheme = activeSlot.theme;
      // Recompute so the just-parked slot counts as covered for targeting + the assessment below.
      effectiveDataAnswered = applyFills(dataSlots, state.dataSlotAnswered ?? [], dataSlotFills);
    }
  }

  // 2.6 Contradiction phase (F4.3 detect + F4.4 refine + the probe-confirm flow), shared verbatim
  //     with question mode (`runTurn`). It compares the BACKGROUND question answers — and the
  //     respondent's latest message — so a same-slot reversal ("I hate the job" → "I love my job")
  //     is caught even when extraction didn't overwrite the stored answer. Under `probe` mode a fresh
  //     contradiction DEFERS: ask a reconciliation question, suppress this turn's writes (including
  //     the data-slot fills), and park the finding; the next turn resolves it. Under `flag` mode it
  //     surfaces the explanation and refines immediately.
  const contradiction = await runContradictionPhase(effective, invokers, {
    hasMessage,
    disregarded,
    dataMode: true,
    labels: questionProbeLabels(effective.questions),
    // Detect against the PRE-merge answers so a value this turn's extraction overwrote stays visible.
    priorAnswers: state.existingAnswers,
  });
  costUsd += contradiction.costUsd;
  toolCalls.push(...contradiction.toolCalls);
  events.push(...contradiction.events);
  contradictions = contradiction.contradictions;
  answerRefinements = contradiction.answerRefinements;
  // Probe raised → record nothing this turn (neither question answers nor data-slot fills) until the
  // respondent confirms on the next turn.
  if (contradiction.suppressWrites) {
    answerUpserts.length = 0;
    dataSlotFills = [];
  }

  // Background deliverable: completion is gated on ALL questions being answered.
  const answeredIds = new Set(effective.answered.map((a) => a.questionId));
  const remainingQuestions = unansweredQuestions({
    questions: effective.questions,
    answered: effective.answered,
  });
  const allQuestionsAnswered = remainingQuestions.length === 0 && effective.questions.length > 0;

  // The progress/assessment the route persists + the panel reads (question coverage).
  const dataSlotCoverage =
    effective.questions.length === 0 ? 1 : answeredIds.size / effective.questions.length;
  const assessment: CompletionAssessment = {
    kind: allQuestionsAnswered ? 'offer' : 'not_ready',
    coverage: dataSlotCoverage,
    answeredCount: answeredIds.size,
    requiredUnansweredKeys: [],
    capReached: false,
    earlyFinishAvailable: isEarlyFinishAvailable(state.config, dataSlotCoverage, answeredIds.size),
    unmet: allQuestionsAnswered ? [] : ['coverage_below_threshold'],
    rationale: allQuestionsAnswered
      ? 'All questions answered; ready to submit.'
      : `${remainingQuestions.length} question(s) still unanswered.`,
  };

  // 3. Respond.
  let response: TurnResponse;
  let targetedQuestionId: string | null = null;
  // Captured for the "watch it think" reasoning trace — a friendly, respondent-safe account of why
  // the conversation moves where it does this turn. Data-slot targeting is deterministic (topic-local
  // / bridge / sweep), so we phrase the rationale here rather than carry a selector's string.
  let selectionRationale: string | undefined;

  const unfilled = unfilledDataSlots(dataSlots, effectiveDataAnswered);

  // Deepen a volunteered tangent (be led by the respondent): when THIS turn captured a STRONG,
  // volunteered opinion on a NON-active topic — a `direct`, non-provisional fill on a slot other than
  // the one we were exploring — that slot is now covered and drops out of `unfilled`, so the
  // interviewer could never follow up on what they're plainly animated about (the "capture-and-drop"
  // gap). Re-surface such slots to the selector so it CAN choose to go a little deeper. Bounded to
  // "deepen once": once targeted, the slot becomes the active slot next turn and no longer qualifies
  // as a non-active tangent — so the conversation deepens once, then moves on.
  const deepenCandidates: DataSlotTarget[] = (hasMessage && !disregarded ? dataSlotFills : [])
    .filter(
      (f) =>
        f.provenance === 'direct' && !f.provisional && f.dataSlotKey !== state.activeDataSlotKey
    )
    .map((f) => dataSlots.find((s) => s.key === f.dataSlotKey))
    .filter((s): s is DataSlotTarget => s !== undefined && !unfilled.some((u) => u.id === s.id));

  // Balanced progress: surface unanswered REQUIRED questions directly when the background question
  // coverage falls behind the data-slot coverage — the conversation is filling slots but not
  // capturing the mandatory answers (data slots are coarser than questions, so some required
  // questions a theme should have answered slip through). Rather than wait for the end-of-run
  // sweep, ask the next required question now whenever every data slot is filled OR the question
  // coverage lags the data-slot coverage by more than {@link BALANCED_QUESTION_LAG}.
  const requiredRemaining = remainingQuestions.filter((qn) => qn.required);
  const dataCoverage =
    dataSlots.length === 0 ? 1 : (dataSlots.length - unfilled.length) / dataSlots.length;
  const questionCoverage = coverageRatio(effective);
  const questionsLagging = dataCoverage - questionCoverage > BALANCED_QUESTION_LAG;

  if (contradiction.probe) {
    // Probe-confirm flow: ask the reconciliation question instead of targeting a slot/question.
    // Nothing was recorded this turn; the pending finding is persisted (below).
    response = {
      kind: 'contradiction_probe',
      text: contradiction.probe.text,
      slotKeys: contradiction.probe.slotKeys,
    };
    targetedQuestionId = null;
    selectionRationale = 'Checking an apparent change of heart before updating earlier answers.';
  } else if (allQuestionsAnswered) {
    if (effective.flags.completion) {
      response = {
        kind: 'offer',
        input: buildOfferInput(effective, dataSlots, effectiveDataAnswered, answeredIds.size),
      };
    } else {
      response = { kind: 'complete', text: DATA_SLOT_COMPLETE_MESSAGE };
    }
  } else if (requiredRemaining.length > 0 && (unfilled.length === 0 || questionsLagging)) {
    // Interleave a required question directly (kept conversational by the route's phraser).
    const next = requiredRemaining[0];
    toolCalls.push(toolCall(DATA_SLOT_SELECTION_TOOL_SLUG, true));
    response = { kind: 'question', questionId: next.id, text: next.prompt ?? '' };
    targetedQuestionId = next.id;
    selectionRationale = 'Bringing in a required detail we still need to capture.';
  } else if (unfilled.length > 0) {
    // Target the next data slot. By default topic-local (linger in the current theme) via the
    // deterministic pick; when we just parked a slot, bridge to a DIFFERENT theme so the move-on
    // reads as forward progress. When adaptive data-slot selection is wired (50+-slot scale), let
    // the embedding-ranked LLM selector choose the slot that flows most naturally from what was
    // just said instead — fail-soft to the deterministic pick (off-pool / null → deterministic).
    const activeTheme = state.activeDataSlotKey
      ? (dataSlots.find((s) => s.key === state.activeDataSlotKey)?.theme ?? null)
      : null;
    // Offer just-volunteered tangent slots alongside the unfilled set so the selector can deepen them.
    const candidatePool =
      deepenCandidates.length > 0 ? [...deepenCandidates, ...unfilled] : unfilled;
    const adaptivePick = invokers.selectDataSlot
      ? await invokers.selectDataSlot(state, candidatePool, {
          activeTheme,
          parkedTheme: parkedTheme ?? null,
        })
      : null;
    let next: DataSlotTarget;
    if (adaptivePick) {
      const chosen = candidatePool.find((s) => s.key === adaptivePick.dataSlotKey);
      // Trust only an in-pool pick; an off-pool key falls back to the deterministic order.
      next = chosen ?? pickNextDataSlot(unfilled, state.activeDataSlotKey, dataSlots, parkedTheme);
      costUsd += adaptivePick.costUsd;
    } else {
      next = pickNextDataSlot(unfilled, state.activeDataSlotKey, dataSlots, parkedTheme);
    }
    // A deepen pick is a covered slot the respondent just raised — frame it as a follow-up (re-ask),
    // not a fresh move into a new area, so the interviewer goes deeper on what they volunteered.
    const isDeepen = deepenCandidates.some((s) => s.id === next.id);
    const isReask = isDeepen || next.key === state.activeDataSlotKey;
    const isTransition = !isDeepen && activeTheme !== null && activeTheme !== next.theme;
    toolCalls.push(toolCall(DATA_SLOT_SELECTION_TOOL_SLUG, true));
    response = {
      kind: 'data_slot',
      dataSlotId: next.id,
      dataSlotKey: next.key,
      name: next.name,
      description: next.description,
      theme: next.theme,
      isReask,
      isTransition,
    };
    selectionRationale = isDeepen
      ? `Following up on what they raised about ${next.name} before moving on.`
      : isReask
        ? 'Circling back to understand this a little better.'
        : isTransition
          ? `Moving on to a new area: ${next.theme}.`
          : 'Staying with this topic to go a little deeper.';
  } else {
    // Every data slot is filled, but a background question is still open → ask it directly.
    const next = remainingQuestions[0];
    toolCalls.push(toolCall(DATA_SLOT_SELECTION_TOOL_SLUG, true));
    response = { kind: 'question', questionId: next.id, text: next.prompt ?? '' };
    targetedQuestionId = next.id;
    selectionRationale = 'Filling in the last few questions we still need.';
  }

  // Signpost support LAST so it wins the chat's single notice slot (the hook keeps one warning).
  // Fires on a first serious disclosure; copy is the admin's message, or a reviewed default when
  // blank (so enabling sensitivity always signposts — no silent empty-message footgun).
  if (sensitivity?.signpost) {
    events.push({
      type: 'warning',
      code: 'support',
      message: composeSupportMessage(
        effectiveSupportMessage(state.config.supportMessage),
        state.config.supportResourceUrl
      ),
    });
  }

  return {
    response,
    targetedQuestionId,
    ...(selectionRationale !== undefined ? { selectionRationale } : {}),
    sideEffects: {
      answerUpserts,
      answerRefinements,
      dataSlotFills,
      ...(contradiction.pendingContradiction !== undefined
        ? { pendingContradiction: contradiction.pendingContradiction }
        : {}),
    },
    events,
    toolCalls,
    costUsd,
    contradictions,
    assessment,
    ...(abuse !== undefined ? { abuse } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
  };
}
