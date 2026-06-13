/**
 * Answer-intent normalisation (F4.2).
 *
 * Pure data-in / data-out: takes the LLM-reported `answers` (already
 * schema-valid) plus the {@link ExtractionContext} they were extracted against,
 * and returns the version-agnostic {@link AnswerSlotIntent}[] F4.6 will persist.
 * The F4.2 analogue of F1.1's `normalizeChangeRecords` — it normalises or drops
 * an individual odd answer rather than failing the whole turn. Jobs:
 *
 *  1. Resolve the slot — an answer whose `slotKey` isn't a candidate is dropped
 *     (the model hallucinated a slot).
 *  2. Validate the value against the slot's real type + config (`answer-value.ts`)
 *     — choice membership, likert/numeric bounds. A value that fails is dropped
 *     with the reason.
 *  3. Coerce provenance — a `direct` answer with no `sourceQuote` is downgraded to
 *     `inferred` (it can't substantiate a verbatim claim), not dropped.
 *  4. Tag the active question vs side-effects, and resolve `questionType` from the
 *     slot (the slot's type is always authoritative).
 *  5. De-duplicate per slot — if the model answers the same slot twice, keep the
 *     highest-confidence intent and drop the rest.
 *
 * No Prisma / Next.js. `slotKey` is resolved to `AppQuestionSlot.id` at persist
 * time (F4.6).
 */

import type { AnswerProvenance } from '@/lib/app/questionnaire/types';
import { validateAnswerValue } from '@/lib/app/questionnaire/extraction/answer-value';
import type { ExtractedAnswer } from '@/lib/app/questionnaire/extraction/extraction-schema';
import type {
  AnswerExtractionResult,
  AnswerSlotIntent,
  DroppedAnswer,
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

/** Build the per-answer intent once its value is validated and slot resolved. */
function toIntent(
  answer: ExtractedAnswer,
  slot: ExtractionSlotView,
  normalisedValue: unknown,
  activeQuestionKey: string | null
): AnswerSlotIntent {
  // A `direct` claim needs a span to substantiate it. A missing OR blank quote
  // (the model omitted it, or sent an empty/whitespace string) can't substantiate
  // a verbatim claim, so call it `inferred` rather than trusting the label.
  const hasQuote = typeof answer.sourceQuote === 'string' && answer.sourceQuote.trim().length > 0;
  const provenance: AnswerProvenance =
    answer.provenance === 'direct' && !hasQuote ? 'inferred' : answer.provenance;

  const intent: AnswerSlotIntent = {
    slotKey: slot.key,
    questionType: slot.type,
    value: normalisedValue,
    confidence: answer.confidence,
    provenance,
    rationale: answer.rationale,
    isActiveQuestion: activeQuestionKey !== null && slot.key === activeQuestionKey,
  };
  // Keep the quote only when it still substantiates a `direct` value (omitting the
  // key when absent, matching the F1.1 baseIntent discipline).
  if (provenance === 'direct' && hasQuote) {
    intent.sourceQuote = answer.sourceQuote;
  }
  return intent;
}

/**
 * Normalise the extractor's reported answers against the context. See module doc.
 * Returns coherent, type-valid intents plus the answers removed (with reasons)
 * for logging.
 */
export function normalizeAnswerIntents(
  answers: ExtractedAnswer[],
  ctx: ExtractionContext
): AnswerExtractionResult {
  const dropped: DroppedAnswer[] = [];
  const slotByKey = new Map(ctx.candidateSlots.map((s) => [s.key, s]));

  // First pass: resolve + validate into candidate intents.
  const candidates: AnswerSlotIntent[] = [];
  for (const answer of answers) {
    const slot = slotByKey.get(answer.slotKey);
    if (!slot) {
      dropped.push({ slotKey: answer.slotKey, reason: 'unknown slot key' });
      continue;
    }

    const valueResult = validateAnswerValue(slot.type, answer.value, slot.typeConfig);
    if (!valueResult.ok) {
      dropped.push({
        slotKey: answer.slotKey,
        reason: `value invalid for type: ${valueResult.issue}`,
      });
      continue;
    }

    candidates.push(toIntent(answer, slot, valueResult.value, ctx.activeQuestionKey));
  }

  // Second pass: de-duplicate per slot, keeping the highest-confidence intent.
  // Higher confidence wins; an exact tie keeps the first seen (stable).
  const best = new Map<string, AnswerSlotIntent>();
  for (const intent of candidates) {
    const incumbent = best.get(intent.slotKey);
    if (!incumbent) {
      best.set(intent.slotKey, intent);
      continue;
    }
    if (intent.confidence > incumbent.confidence) {
      best.set(intent.slotKey, intent);
      dropped.push({ slotKey: incumbent.slotKey, reason: 'duplicate slot, lower confidence' });
    } else {
      dropped.push({ slotKey: intent.slotKey, reason: 'duplicate slot, lower confidence' });
    }
  }

  return { intents: [...best.values()], dropped };
}
