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
 * BOTH question types go through the answer-fit resolver, which judges each mapped question on its
 * own wording:
 *  - **choice / likert** mapped questions are mapped onto their option / scale point;
 *  - **free-text** mapped questions are answered in THEIR OWN terms from what the respondent said,
 *    or omitted when the conversation covered the theme without speaking to that specific question.
 *
 * Free text used to be seeded HERE instead, deterministically, by copying the fill's paraphrase onto
 * every mapped question. That is the `JP29` defect: a data slot mapping three ego/Higher-Self
 * questions produced three byte-identical answers, none of which addressed the question above it. One
 * paraphrase cannot answer three different questions, and no confidence cap makes a misfiled answer
 * right — so the per-question judgment the typed path always had is now applied to free text too.
 * The deterministic seed survives only as a failure fallback, and only where duplication is
 * impossible (see {@link soleMappedFreeTextTargets}).
 *
 * The opportunistic answer is written at a capped confidence, provenance `inferred`, but the two
 * types cap differently. A free-text answer is prose the respondent never offered for THIS question,
 * so it stays at the Tentative {@link OPPORTUNISTIC_CONFIDENCE_CAP} — a guess below the completion
 * floor that pulls the agent back to confirm it. A choice/likert fill carries the resolver's own
 * mapping-clarity judgment, so it keeps that (up to {@link OPPORTUNISTIC_TYPED_CONFIDENCE_CAP}): a
 * clearly-pinned answer reads "Fairly sure" and can cross the completion floor without a naggy
 * re-ask, while a loose fit still lands low and is confirmed later. Numeric/boolean/date are out of
 * scope: there's no honest free-form→value mapping for them here, so they wait for the extractor (or
 * a direct statement).
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
 * Confidence ceiling for a FREE-TEXT opportunistic answer. 0.45 is the floor of the "Tentative" band
 * (`panel/confidence.ts`), so it reads as a guess and sits below the completion floor until
 * confirmed. Confirmation then strengthens it via the accrual guard. The ceiling stays flat even now
 * that the resolver tailors the prose per question: unlike a scale point — which a clear sentiment
 * can genuinely PIN — free-text prose is the respondent's account in their own words, and an account
 * they never actually gave for THIS question is a guess however well it reads. The typed path is not
 * flattened this way — see {@link OPPORTUNISTIC_TYPED_CONFIDENCE_CAP}.
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
      // numeric / boolean / date / matrix: no honest free-form→value mapping here — a matrix
      // needs a per-row composite the fit resolver can't produce — so leave them for the extractor.
    }
  }

  return { freeText, typed: [...typedByKey.values()] };
}

/**
 * The free-text targets to hand the answer-fit resolver — one candidate view per mapped question, so
 * the model judges each question on its own wording rather than receiving one blanket paraphrase.
 */
export function freeTextFitCandidates(
  freeText: OpportunisticTargets['freeText']
): ExtractionSlotView[] {
  return freeText.map((target) => target.slot);
}

/**
 * FAILURE FALLBACK ONLY — the free-text targets it is still safe to seed deterministically when the
 * resolver pass could not run (provider error, schema failure after retry). A fill is safe exactly
 * when it maps to ONE free-text question: there is a single place for its paraphrase to land, so
 * copying it there cannot produce the duplication this module exists to prevent, and the `53ZF` gap
 * (a confident fill stranded beside an empty form) still gets closed on the degraded path.
 *
 * A fill mapping several free-text questions is dropped entirely rather than seeded into an
 * arbitrary one of them — picking a winner among questions we could not judge would be a coin toss
 * presented to the respondent as an answer.
 */
export function soleMappedFreeTextTargets(
  freeText: OpportunisticTargets['freeText']
): OpportunisticTargets['freeText'] {
  const countByFill = new Map<string, number>();
  for (const { fill } of freeText) {
    countByFill.set(fill.dataSlotKey, (countByFill.get(fill.dataSlotKey) ?? 0) + 1);
  }
  return freeText.filter(({ fill }) => countByFill.get(fill.dataSlotKey) === 1);
}

/**
 * Build the deterministic free-text intents from the selected targets — the fill's paraphrase
 * (falling back to a formatted value) at the capped Tentative confidence, provenance `inferred`.
 * A target whose fill yields no usable text is skipped (never write an empty answer).
 *
 * Reachable only via {@link soleMappedFreeTextTargets} on the resolver-failure path. Do NOT call it
 * on the normal path: it has no per-question judgment, so a many-mapped fill would paste one
 * paraphrase under every question again.
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
    confidence: Math.min(
      intent.confidence,
      // Free text rides the same pass but keeps the flat Tentative ceiling — the resolver judged
      // that their words answer this question, not that they gave this account of it.
      intent.questionType === 'free_text'
        ? OPPORTUNISTIC_CONFIDENCE_CAP
        : OPPORTUNISTIC_TYPED_CONFIDENCE_CAP
    ),
    provenance: 'inferred' as const,
  }));
}

/** Collapse whitespace/case/punctuation so near-identical prose compares equal. */
function normaliseText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return key.length > 0 ? key : null;
}

/**
 * LAST-LINE INVARIANT — never let one turn write the same free-text answer under two questions.
 *
 * The prompt tells the resolver to tailor each answer and omit rather than repeat, but a prompt is a
 * request, not a guarantee: a model that ignores it would reproduce the `JP29` screenshot exactly.
 * This is the deterministic backstop, so the defect cannot recur regardless of model behaviour.
 *
 * On a collision the HIGHEST-confidence intent survives (ties keep the first seen, so the order the
 * resolver returned is stable); the rest are dropped and returned for logging. Typed answers are
 * untouched — two questions legitimately share the scale point `3`, and identical typed values carry
 * no misfiled prose.
 */
export function dedupeIdenticalFreeText(intents: AnswerSlotIntent[]): {
  intents: AnswerSlotIntent[];
  dropped: { slotKey: string; reason: string }[];
} {
  const winnerByText = new Map<string, AnswerSlotIntent>();
  const dropped: { slotKey: string; reason: string }[] = [];
  const kept: AnswerSlotIntent[] = [];

  for (const intent of intents) {
    const key = intent.questionType === 'free_text' ? normaliseText(intent.value) : null;
    if (key === null) {
      kept.push(intent);
      continue;
    }
    const incumbent = winnerByText.get(key);
    if (!incumbent) {
      winnerByText.set(key, intent);
      kept.push(intent);
      continue;
    }
    if (intent.confidence > incumbent.confidence) {
      winnerByText.set(key, intent);
      kept.splice(kept.indexOf(incumbent), 1, intent);
      dropped.push({ slotKey: incumbent.slotKey, reason: 'duplicate free-text answer' });
    } else {
      dropped.push({ slotKey: intent.slotKey, reason: 'duplicate free-text answer' });
    }
  }

  return { intents: kept, dropped };
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
