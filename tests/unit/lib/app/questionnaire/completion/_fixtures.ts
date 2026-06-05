/**
 * Shared builders for completion-logic unit tests. Not a test file (no `.test.ts`
 * suffix) so Vitest won't run it as a suite. Reuses the selection `q` builder so the
 * two layers' `QuestionView` fixtures can't drift.
 */

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  type QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';
import type { AnsweredView } from '@/lib/app/questionnaire/selection/types';
import type { CompletionContext } from '@/lib/app/questionnaire/completion/types';
import { q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

export { q };

/** Build a `CompletionContext`, merging config over the resolved defaults. */
export function cctx(input: {
  questions: CompletionContext['questions'];
  answered?: AnsweredView[];
  config?: Partial<QuestionnaireConfigShape>;
  sessionId?: string;
}): CompletionContext {
  return {
    questions: input.questions,
    answered: input.answered ?? [],
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...input.config },
    sessionId: input.sessionId ?? 'sess-1',
  };
}
