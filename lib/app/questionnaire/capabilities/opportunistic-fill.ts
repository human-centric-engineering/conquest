/**
 * Opportunistic down-propagation — seed a data slot's mapped questions from a confident fill.
 *
 * The core of ConQuest is removing the hassle of form-filling. When the extractor confidently
 * captures the respondent's position on a theme (a data-slot fill), the questions that theme maps
 * to should fill out too — even on a hunch — rather than sitting empty while the insight is
 * stranded in the panel (the `53ZF` gap: a confident "Enablement resources" fill, but its two
 * mapped questions left at "0 of 2 filled").
 *
 * The extractor is already *told* to answer mapped questions when it fills a slot; this is the
 * deterministic safety net for when it doesn't — the down-propagation analogue of the existing
 * question→data-slot gap-filler (`reconcileChatDataSlotFills`).
 *
 * Two paths, by question type:
 *  - **free-text** mapped questions are seeded HERE, deterministically, from the fill's paraphrase
 *    (no LLM);
 *  - **choice / likert** mapped questions are handed back to the capability to run through the
 *    answer-fit resolver (the same machinery that maps a free-form answer onto an option/scale).
 *
 * The opportunistic answer is written at a capped confidence, provenance `inferred`, but the two
 * paths cap differently. A free-text seed is a raw paraphrase copy with no per-question fit
 * judgment, so it stays at the Tentative {@link OPPORTUNISTIC_CONFIDENCE_CAP} — a guess below the
 * completion floor that pulls the agent back to confirm it. A choice/likert fill carries the
 * answer-fit resolver's own mapping-clarity judgment, so it keeps that (up to
 * {@link OPPORTUNISTIC_TYPED_CONFIDENCE_CAP}): a clearly-pinned answer reads "Fairly sure" and can
 * cross the completion floor without a naggy re-ask, while a loose fit still lands low and is
 * confirmed later. Numeric/boolean/date are out of scope: there's no honest free-form→value mapping
 * for them here, so they wait for the extractor (or a direct statement).
 *
 * Pure + dependency-light — no Prisma/LLM imports — so it's unit-testable in isolation; the
 * capability owns the LLM fit call and the persistence flows through the normal turn-run upsert
 * (gaining the Phase 1 confidence-accrual guard).
 */

import type {
  AnswerSlotIntent,
  DataSlotCandidateView,
  DataSlotFillIntent,
  ExtractionAnsweredView,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

/**
 * Minimum data-slot fill confidence to down-propagate from. Aligned with the orchestrator's
 * `DATA_SLOT_FILLED_THRESHOLD` (0.5): we only seed mapped questions from a fill we'd already call
 * "filled", never from a weak/tangential one.
 */
export const OPPORTUNISTIC_FILL_FLOOR = 0.5;

/**
 * Confidence ceiling for a FREE-TEXT opportunistic seed. 0.45 is the floor of the "Tentative" band
 * (`panel/confidence.ts`), so a seeded answer reads as a guess and sits below the completion floor
 * until confirmed. Confirmation then strengthens it via the accrual guard. A free-text seed is a raw
 * copy of the fill's paraphrase down onto the mapped question — there is no per-question judgment of
 * how well it fits, so the flat "to be confirmed" ceiling is right here (the typed path below is not
 * flattened this way — see {@link OPPORTUNISTIC_TYPED_CONFIDENCE_CAP}).
 */
export const OPPORTUNISTIC_CONFIDENCE_CAP = 0.45;

/**
 * Confidence ceiling for a TYPED (choice / likert) opportunistic fill. Unlike the free-text seed, a
 * typed fill is routed through the answer-fit resolver, whose confidence IS an explicit judgment of
 * how cleanly the respondent's position maps onto the option / scale point. We PRESERVE that
 * judgment (clamping only the ceiling) rather than flattening every mapping to the same low "guess"
 * score: a clearly-pinned likert ("I hate my job" → the bottom of a satisfaction scale) should read
 * "Fairly sure", not "Tentative", even when it was derived tangentially and stated briefly — a
 * closed answer is inferred from sentiment, never dictated verbatim, so brevity is not doubt. The
 * ceiling sits below the "Confident" band (0.85): an inferred answer never claims full certainty on
 * first hearing, but corroboration can lift it there via the accrual guard. A genuinely loose fit
 * keeps its own lower score and stays below the completion floor to be confirmed.
 */
export const OPPORTUNISTIC_TYPED_CONFIDENCE_CAP = 0.75;

/**
 * Default confidence at/above which an answer counts as confirmed and is left alone by the refresh
 * path — below it, an opportunistic (inferred) answer is still "to be confirmed" and a corroborating
 * turn strengthens it. 0.5 gates the opportunistic guesses (capped at 0.45) without holding back a
 * genuine, real answer. The per-questionnaire `answerConfidenceFloor` config overrides this (it also
 * gates completion); this constant is the fallback when none is threaded through.
 */
export const ANSWER_CONFIRM_FLOOR = 0.5;

/** Question types the answer-fit resolver can map a free-form position onto. */
const FIT_TYPES = new Set(['single_choice', 'multi_choice', 'likert']);

export interface OpportunisticTargets {
  /** Free-text mapped questions to seed deterministically from the fill's paraphrase. */
  freeText: { slot: ExtractionSlotView; fill: DataSlotFillIntent }[];
  /** Choice/likert mapped questions to route through the answer-fit resolver. */
  typed: ExtractionSlotView[];
}

/** Minimal, dependency-free restatement of a leaf value when a fill has no paraphrase. */
function formatLeaf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(formatLeaf).filter(Boolean).join(', ');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value).trim();
  }
  return '';
}

/**
 * Pick the still-unanswered mapped questions to seed from this turn's confident data-slot fills.
 *
 * A question is eligible only when it is NOT already answered (`answeredKeys` — this turn's intents,
 * the fit pass, and prior turns) AND is present in `candidateSlots` (the unanswered set, where its
 * type/options live). This is what keeps us from overwriting a real answer with a guess.
 */
export function selectOpportunisticTargets(opts: {
  dataSlotFills: DataSlotFillIntent[];
  dataSlotCandidates: DataSlotCandidateView[];
  candidateSlots: ExtractionSlotView[];
  /** Slot keys already answered this turn (intents + fit) or on a prior turn — never re-targeted. */
  answeredKeys: Set<string>;
}): OpportunisticTargets {
  const candidateByKey = new Map(opts.candidateSlots.map((s) => [s.key, s]));
  const dataSlotByKey = new Map(opts.dataSlotCandidates.map((c) => [c.key, c]));
  const freeText: OpportunisticTargets['freeText'] = [];
  const typedByKey = new Map<string, ExtractionSlotView>();
  const seenFreeText = new Set<string>();

  for (const fill of opts.dataSlotFills) {
    if ((fill.confidence ?? 0) < OPPORTUNISTIC_FILL_FLOOR) continue;
    const mapped = dataSlotByKey.get(fill.dataSlotKey)?.mappedQuestionKeys ?? [];
    for (const questionKey of mapped) {
      if (opts.answeredKeys.has(questionKey)) continue;
      const slot = candidateByKey.get(questionKey);
      if (!slot) continue; // not an unanswered candidate (already answered, or capped out of the prompt)
      if (slot.type === 'free_text') {
        if (seenFreeText.has(questionKey)) continue; // first contributing fill wins the paraphrase
        seenFreeText.add(questionKey);
        freeText.push({ slot, fill });
      } else if (FIT_TYPES.has(slot.type)) {
        if (!typedByKey.has(questionKey)) typedByKey.set(questionKey, slot);
      }
      // numeric / boolean / date: no honest free-form→value mapping here — leave for the extractor.
    }
  }

  return { freeText, typed: [...typedByKey.values()] };
}

/**
 * Build the deterministic free-text intents from the selected targets — the fill's paraphrase
 * (falling back to a formatted value) at the capped Tentative confidence, provenance `inferred`.
 * A target whose fill yields no usable text is skipped (never write an empty answer).
 */
export function buildFreeTextOpportunisticIntents(
  freeText: OpportunisticTargets['freeText']
): AnswerSlotIntent[] {
  const intents: AnswerSlotIntent[] = [];
  for (const { slot, fill } of freeText) {
    const text = (fill.paraphrase ?? '').trim() || formatLeaf(fill.value);
    if (!text) continue;
    intents.push({
      slotKey: slot.key,
      questionType: 'free_text',
      value: text,
      confidence: OPPORTUNISTIC_CONFIDENCE_CAP,
      provenance: 'inferred',
      rationale: 'Inferred from your account of this topic — to be confirmed.',
      isActiveQuestion: false,
      paraphrase: text,
    });
  }
  return intents;
}

/**
 * Cap the answer-fit resolver's typed (choice / likert) intents and mark them `inferred`. The
 * resolver already judged how cleanly the respondent's thematic statement maps onto the option /
 * scale point; we PRESERVE that judgment up to {@link OPPORTUNISTIC_TYPED_CONFIDENCE_CAP} rather than
 * flattening every inferred mapping to the same low "guess" score. So a clearly-pinned answer reads
 * "Fairly sure" and counts toward completion — no naggy re-ask of a likert the conversation already
 * answered by sentiment — while a genuinely loose fit keeps its low score and stays below the floor
 * to be confirmed. Provenance is always `inferred`: the respondent never stated the typed value
 * outright, and the panel still shows the "Inferred" marker alongside the confidence.
 */
export function capOpportunisticConfidence(intents: AnswerSlotIntent[]): AnswerSlotIntent[] {
  return intents.map((intent) => ({
    ...intent,
    confidence: Math.min(intent.confidence, OPPORTUNISTIC_TYPED_CONFIDENCE_CAP),
    provenance: 'inferred' as const,
  }));
}

/** A still-tentative mapped answer to strengthen because its theme was corroborated this turn. */
export interface RefreshTarget {
  slotKey: string;
  value: unknown;
  questionType: AnswerSlotIntent['questionType'];
  /** The strengthened parent-fill confidence to write — the Phase 1 accrual guard only ever raises. */
  confidence: number;
}

/**
 * Pick the tentative mapped answers to STRENGTHEN this turn — the confirmation half of the loop.
 *
 * An opportunistic fill lands below the confirm floor (a guess). When a later turn corroborates the
 * theme, its data-slot fill's confidence climbs (the extractor already does this for data slots).
 * This re-emits each below-floor, `inferred` mapped answer of a fill that STRENGTHENED this turn,
 * at the fill's new confidence — re-stating the SAME value, so the Phase 1 accrual guard raises the
 * answer's score (never lowers it) and it crosses into "confirmed" after a confirmation or two.
 *
 * Strictly gated so confidence can't drift up on its own: only fills whose confidence rose vs their
 * prior recorded value (`current.confidence`) qualify — a flat re-emit of an unchanged fill is
 * ignored. Already-confident answers (≥ floor) and respondent/refined answers (provenance ≠
 * inferred) are left untouched. Questions handled this turn (seed/extraction) are excluded.
 */
export function selectRefreshTargets(opts: {
  dataSlotFills: DataSlotFillIntent[];
  dataSlotCandidates: DataSlotCandidateView[];
  answered: ExtractionAnsweredView[];
  /** Keys already handled this turn (extraction intents, fit, opportunistic seed) — never refreshed. */
  handledKeys: Set<string>;
  confirmFloor: number;
}): RefreshTarget[] {
  const answeredByKey = new Map(opts.answered.map((a) => [a.slotKey, a]));
  const dataSlotByKey = new Map(opts.dataSlotCandidates.map((c) => [c.key, c]));
  const out = new Map<string, RefreshTarget>();

  for (const fill of opts.dataSlotFills) {
    if ((fill.confidence ?? 0) < OPPORTUNISTIC_FILL_FLOOR) continue;
    const cand = dataSlotByKey.get(fill.dataSlotKey);
    const prior = cand?.current?.confidence;
    // Genuine corroboration only: the fill must have STRENGTHENED vs its prior recorded confidence.
    if (typeof prior !== 'number' || fill.confidence <= prior) continue;
    for (const questionKey of cand?.mappedQuestionKeys ?? []) {
      if (opts.handledKeys.has(questionKey)) continue;
      const answer = answeredByKey.get(questionKey);
      if (!answer || answer.value === undefined) continue; // not already answered → a seed case, not refresh
      if (answer.provenance !== 'inferred') continue; // only strengthen opportunistic/inferred answers
      if ((answer.confidence ?? 1) >= opts.confirmFloor) continue; // already confirmed — leave it
      if (!out.has(questionKey)) {
        out.set(questionKey, {
          slotKey: questionKey,
          value: answer.value,
          questionType: answer.questionType ?? 'free_text',
          confidence: fill.confidence,
        });
      }
    }
  }

  return [...out.values()];
}

/**
 * Build the refresh intents — same value, the strengthened confidence, provenance `inferred`. Re-
 * emitting the SAME value routes through the Phase 1 corroboration path in the turn upsert (which
 * only raises the score), so this never fabricates a change, only firms up a tentative answer.
 */
export function buildRefreshIntents(targets: RefreshTarget[]): AnswerSlotIntent[] {
  return targets.map((target) => ({
    slotKey: target.slotKey,
    questionType: target.questionType,
    value: target.value,
    confidence: target.confidence,
    provenance: 'inferred' as const,
    rationale: 'Corroborated by your latest message — strengthening this answer.',
    isActiveQuestion: false,
  }));
}
