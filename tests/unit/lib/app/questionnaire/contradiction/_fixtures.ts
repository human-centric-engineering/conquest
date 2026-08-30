/**
 * Shared builders for contradiction-detection unit tests. Not a test file (no
 * `.test.ts` suffix) so Vitest won't run it as a suite.
 */

import type { QuestionType } from '@/lib/app/questionnaire/types';
import type { DetectedContradiction } from '@/lib/app/questionnaire/contradiction/detection-schema';
import type {
  AnsweredSlotView,
  ContradictionContext,
  ContradictionSlotView,
} from '@/lib/app/questionnaire/contradiction/types';

/** Build a `ContradictionSlotView`, defaulting everything but the required `key`. */
export function slot(
  partial: Partial<ContradictionSlotView> & { key: string }
): ContradictionSlotView {
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

/** Build an `AnsweredSlotView`, defaulting plumbing but the required `slotKey`. */
export function answered(
  partial: Partial<AnsweredSlotView> & { slotKey: string }
): AnsweredSlotView {
  return {
    slotKey: partial.slotKey,
    // `value` may legitimately be falsy (0, false, '') — `??` only defaults null/undefined.
    value: partial.value ?? 'an answer',
    confidence: partial.confidence ?? 0.9,
    ...(partial.provenance !== undefined ? { provenance: partial.provenance } : {}),
    ...(partial.turnIndex !== undefined ? { turnIndex: partial.turnIndex } : {}),
  };
}

/**
 * Build a `ContradictionContext`. Slots default to one per answered key (so every
 * answer resolves), and `mode` defaults to `flag`.
 */
export function ctx(input: {
  answers: AnsweredSlotView[];
  slots?: ContradictionSlotView[];
  mode?: ContradictionContext['mode'];
  windowN?: number;
  currentStatement?: string;
  activeQuestion?: ContradictionContext['activeQuestion'];
  recentMessages?: string[];
  sessionId?: string;
}): ContradictionContext {
  const slots = input.slots ?? input.answers.map((a) => slot({ key: a.slotKey }));
  return {
    slots,
    answers: input.answers,
    mode: input.mode ?? 'flag',
    windowN: input.windowN ?? 0,
    ...(input.currentStatement !== undefined ? { currentStatement: input.currentStatement } : {}),
    ...(input.activeQuestion !== undefined ? { activeQuestion: input.activeQuestion } : {}),
    ...(input.recentMessages !== undefined ? { recentMessages: input.recentMessages } : {}),
    sessionId: input.sessionId ?? 'sess-1',
  };
}

/**
 * Session 5GB3M8SS, the false positive that put the active question into the detector's context:
 * 70 hours to "how many are you actually working", then "40 hrs" to "what would be sustainable",
 * raised to the respondent as a contradiction. Both answers were correct; the detector simply
 * could not see that the second number answered a different question.
 */
export const HOURS_FIXTURE = {
  currentQuestion: slot({
    key: 'current_weekly_work_hours',
    prompt: 'How many hours per week are you actually working at the moment across everything?',
  }),
  idealQuestion: slot({
    key: 'sustainable_weekly_hours',
    prompt: 'What would a sustainable total number of weekly hours look like for you?',
  }),
  recordedHours: answered({ slotKey: 'current_weekly_work_hours', value: 70, confidence: 0.917 }),
  latestMessage: '40 hrs',
} as const;

/** Build a raw `DetectedContradiction` (the LLM-reported shape), defaulting plumbing. */
export function contradiction(
  partial: Partial<DetectedContradiction> & { slotKeys: string[] }
): DetectedContradiction {
  return {
    slotKeys: partial.slotKeys,
    explanation: partial.explanation ?? 'the answers cannot both be true',
    severity: partial.severity ?? 'medium',
    confidence: partial.confidence ?? 0.8,
    ...(partial.suggestedProbe !== undefined ? { suggestedProbe: partial.suggestedProbe } : {}),
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
): ContradictionSlotView {
  return slot({ key, type, typeConfig: choices(...values) });
}
