/**
 * Strategy: sequential.
 *
 * Walks the questionnaire in document order — section ordinal, then in-section
 * ordinal — asking the first unanswered question. Required/optional makes no
 * difference: strict order is the whole point. The simplest, fully deterministic
 * strategy and the config default.
 */

import { registerStrategy } from '@/lib/app/questionnaire/selection/registry';
import { terminalDecision, unansweredQuestions } from '@/lib/app/questionnaire/selection/context';
import type {
  SelectionContext,
  SelectionDecision,
  SelectionStrategyPlugin,
} from '@/lib/app/questionnaire/selection/types';

// eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the plugin contract; body is sync.
async function select(ctx: SelectionContext): Promise<SelectionDecision> {
  const terminal = terminalDecision(ctx);
  if (terminal) return terminal;

  // terminalDecision returned null ⇒ at least one question remains.
  const next = unansweredQuestions(ctx)[0];
  return {
    kind: 'ask' as const,
    questionId: next.id,
    rationale: `Next in order: section ${next.sectionOrdinal + 1}, question ${next.ordinal + 1} (${next.key}).`,
    costUsd: 0,
  };
}

export const sequentialStrategy: SelectionStrategyPlugin = {
  slug: 'sequential',
  description: 'Asks questions in document order (section, then position). Deterministic.',
  select,
};

registerStrategy(sequentialStrategy);
