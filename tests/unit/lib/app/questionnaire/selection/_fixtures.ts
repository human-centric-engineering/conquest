/**
 * Shared builders for selection-strategy unit tests. Not a test file (no
 * `.test.ts` suffix) so Vitest won't run it as a suite.
 */

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  type QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';
import type {
  AnsweredView,
  QuestionView,
  SelectionContext,
} from '@/lib/app/questionnaire/selection/types';

/** Build a `QuestionView`, defaulting everything but the required `id`. */
export function q(partial: Partial<QuestionView> & { id: string }): QuestionView {
  return {
    id: partial.id,
    key: partial.key ?? partial.id,
    sectionId: partial.sectionId ?? 's1',
    sectionOrdinal: partial.sectionOrdinal ?? 0,
    ordinal: partial.ordinal ?? 0,
    weight: partial.weight ?? 1,
    required: partial.required ?? false,
    type: partial.type ?? 'free_text',
    tagIds: partial.tagIds ?? [],
    ...(partial.prompt !== undefined ? { prompt: partial.prompt } : {}),
    ...(partial.guidelines !== undefined ? { guidelines: partial.guidelines } : {}),
    ...(partial.rationale !== undefined ? { rationale: partial.rationale } : {}),
  };
}

/** Build a `SelectionContext`, merging config over the resolved defaults. */
export function ctx(input: {
  questions: QuestionView[];
  answered?: AnsweredView[];
  config?: Partial<QuestionnaireConfigShape>;
  round?: number;
  sessionId?: string;
  recentMessages?: string[];
  goal?: string;
  peerDivergenceByKey?: Record<string, number>;
}): SelectionContext {
  return {
    questions: input.questions,
    answered: input.answered ?? [],
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...input.config },
    round: input.round ?? 0,
    sessionId: input.sessionId ?? 'sess-1',
    ...(input.recentMessages ? { recentMessages: input.recentMessages } : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.peerDivergenceByKey ? { peerDivergenceByKey: input.peerDivergenceByKey } : {}),
  };
}
