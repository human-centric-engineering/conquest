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
 * Either way the opportunistic answer is written at a capped, Tentative confidence
 * ({@link OPPORTUNISTIC_CONFIDENCE_CAP}) so it reads as a guess, not a firm answer — which (Phase 4)
 * keeps it below the completion floor and pulls the agent back to confirm it. Numeric/boolean/date
 * are out of scope: there's no honest free-form→value mapping for them here, so they wait for the
 * extractor (or a direct statement).
 *
 * Pure + dependency-light — no Prisma/LLM imports — so it's unit-testable in isolation; the
 * capability owns the LLM fit call and the persistence flows through the normal turn-run upsert
 * (gaining the Phase 1 confidence-accrual guard).
 */

import type {
  AnswerSlotIntent,
  DataSlotCandidateView,
  DataSlotFillIntent,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

/**
 * Minimum data-slot fill confidence to down-propagate from. Aligned with the orchestrator's
 * `DATA_SLOT_FILLED_THRESHOLD` (0.5): we only seed mapped questions from a fill we'd already call
 * "filled", never from a weak/tangential one.
 */
export const OPPORTUNISTIC_FILL_FLOOR = 0.5;

/**
 * Confidence ceiling for an opportunistic fill. 0.45 is the floor of the "Tentative" band
 * (`panel/confidence.ts`), so a seeded answer reads as a guess and — once Phase 4 lands — sits
 * below the completion floor until confirmed. Confirmation then strengthens it via the Phase 1
 * accrual guard.
 */
export const OPPORTUNISTIC_CONFIDENCE_CAP = 0.45;

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
 * Cap the answer-fit resolver's typed intents to the opportunistic ceiling and mark them
 * `inferred`. The resolver returns its own (possibly high) certainty about the option fit, but the
 * respondent never directly answered THIS question — we inferred it from a thematic statement — so
 * it must read as a guess and stay below the completion floor until confirmed.
 */
export function capOpportunisticConfidence(intents: AnswerSlotIntent[]): AnswerSlotIntent[] {
  return intents.map((intent) => ({
    ...intent,
    confidence: Math.min(intent.confidence, OPPORTUNISTIC_CONFIDENCE_CAP),
    provenance: 'inferred' as const,
  }));
}
