/**
 * Shared builders for answer-refinement unit tests. Not a test file (no `.test.ts`
 * suffix) so Vitest won't run it as a suite.
 */

import type { QuestionType } from '@/lib/app/questionnaire/types';
import type { RefinementDecisionRaw } from '@/lib/app/questionnaire/refinement/refinement-schema';
import type {
  ExistingAnswerView,
  RefinementContext,
  RefinementSlotView,
} from '@/lib/app/questionnaire/refinement/types';

/** Build a `RefinementSlotView`, defaulting everything but the required `key`. */
export function slot(partial: Partial<RefinementSlotView> & { key: string }): RefinementSlotView {
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

/** Build an `ExistingAnswerView`, defaulting plumbing but the required `slotKey`. */
export function existing(
  partial: Partial<ExistingAnswerView> & { slotKey: string }
): ExistingAnswerView {
  return {
    slotKey: partial.slotKey,
    // `value` may legitimately be falsy (0, false, '') — `??` only defaults null/undefined.
    value: partial.value ?? 'an answer',
    provenance: partial.provenance ?? 'direct',
    ...(partial.rationale !== undefined ? { rationale: partial.rationale } : {}),
    ...(partial.confidence !== undefined ? { confidence: partial.confidence } : {}),
    ...(partial.turnIndex !== undefined ? { turnIndex: partial.turnIndex } : {}),
    ...(partial.refinementHistory !== undefined
      ? { refinementHistory: partial.refinementHistory }
      : {}),
  };
}

/**
 * Build a `RefinementContext`. Slots default to one per existing answer (so every
 * decision resolves).
 */
export function ctx(input: {
  existingAnswers: ExistingAnswerView[];
  slots?: RefinementSlotView[];
  userMessage?: string;
  triggeringContradiction?: RefinementContext['triggeringContradiction'];
  recentMessages?: string[];
  sessionId?: string;
}): RefinementContext {
  const slots = input.slots ?? input.existingAnswers.map((a) => slot({ key: a.slotKey }));
  return {
    slots,
    existingAnswers: input.existingAnswers,
    sessionId: input.sessionId ?? 'sess-1',
    ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
    ...(input.triggeringContradiction !== undefined
      ? { triggeringContradiction: input.triggeringContradiction }
      : {}),
    ...(input.recentMessages !== undefined ? { recentMessages: input.recentMessages } : {}),
  };
}

/** Build a raw `RefinementDecisionRaw` (the LLM-reported shape), defaulting plumbing. */
export function decision(
  partial: Partial<RefinementDecisionRaw> & { slotKey: string }
): RefinementDecisionRaw {
  return {
    slotKey: partial.slotKey,
    action: partial.action ?? 'refine',
    rationale: partial.rationale ?? 'the respondent clarified this',
    source: partial.source ?? 'clarification',
    confidence: partial.confidence ?? 0.8,
    // `newValue` is intentionally only set when supplied — refine/overwrite need it,
    // leave omits it, and some tests assert the missing-value drop.
    ...('newValue' in partial ? { newValue: partial.newValue } : { newValue: 'a new answer' }),
  };
}

/** A choice config with the given option values (labels mirror the values). */
export function choices(...values: string[]): { choices: Array<{ value: string; label: string }> } {
  return { choices: values.map((v) => ({ value: v, label: v.toUpperCase() })) };
}

/** Convenience: a choice slot over the given option values. */
export function choiceSlot(
  key: string,
  type: QuestionType,
  ...values: string[]
): RefinementSlotView {
  return slot({ key, type, typeConfig: choices(...values) });
}
