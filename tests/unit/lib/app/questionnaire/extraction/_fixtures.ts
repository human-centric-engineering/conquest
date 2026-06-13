/**
 * Shared builders for answer-extraction unit tests. Not a test file (no
 * `.test.ts` suffix) so Vitest won't run it as a suite.
 */

import type { QuestionType } from '@/lib/app/questionnaire/types';
import type { ExtractedAnswer } from '@/lib/app/questionnaire/extraction/extraction-schema';
import type {
  ExtractionAnsweredView,
  ExtractionAttachment,
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

/** Build an `ExtractionSlotView`, defaulting everything but the required `key`. */
export function slot(partial: Partial<ExtractionSlotView> & { key: string }): ExtractionSlotView {
  return {
    id: partial.id ?? `id-${partial.key}`,
    key: partial.key,
    sectionId: partial.sectionId ?? 's1',
    type: partial.type ?? 'free_text',
    typeConfig: partial.typeConfig ?? null,
    prompt: partial.prompt ?? `Prompt for ${partial.key}`,
    required: partial.required ?? false,
    ...(partial.guidelines !== undefined ? { guidelines: partial.guidelines } : {}),
  };
}

/**
 * Build an `ExtractionContext`, defaulting the active key to the first candidate. Pass
 * `activeQuestionKey: null` explicitly for DATA-SLOT MODE (open prompt, no active question).
 */
export function ctx(input: {
  candidateSlots: ExtractionSlotView[];
  activeQuestionKey?: string | null;
  answered?: ExtractionAnsweredView[];
  userMessage?: string;
  recentMessages?: string[];
  attachments?: ExtractionAttachment[];
  sessionId?: string;
}): ExtractionContext {
  return {
    activeQuestionKey:
      input.activeQuestionKey === undefined
        ? (input.candidateSlots[0]?.key ?? 'q1')
        : input.activeQuestionKey,
    candidateSlots: input.candidateSlots,
    answered: input.answered ?? [],
    userMessage: input.userMessage ?? 'a respondent message',
    sessionId: input.sessionId ?? 'sess-1',
    ...(input.recentMessages ? { recentMessages: input.recentMessages } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
}

/** Build a raw `ExtractedAnswer` (the LLM-reported shape), defaulting plumbing. */
export function answer(partial: Partial<ExtractedAnswer> & { slotKey: string }): ExtractedAnswer {
  return {
    slotKey: partial.slotKey,
    // `value` may legitimately be falsy (0, false, '') — `??` only defaults null/undefined.
    value: partial.value ?? 'an answer',
    confidence: partial.confidence ?? 0.9,
    provenance: partial.provenance ?? 'direct',
    rationale: partial.rationale ?? 'because the message says so',
    ...(partial.sourceQuote !== undefined ? { sourceQuote: partial.sourceQuote } : {}),
  };
}

/** A choice config with the given option values (labels mirror the values). */
export function choices(...values: string[]): { choices: Array<{ value: string; label: string }> } {
  return { choices: values.map((v) => ({ value: v, label: v.toUpperCase() })) };
}

/** Convenience: a single-choice slot over the given option values. */
export function choiceSlot(
  key: string,
  type: QuestionType,
  ...values: string[]
): ExtractionSlotView {
  return slot({ key, type, typeConfig: choices(...values) });
}
