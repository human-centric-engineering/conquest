/**
 * Render one {@link ScopeProposedEdit} as a plain-English, one-line description (F17.21).
 *
 * Shared by the admin review card (`ScopeFindingReviewCard`) and the Questionnaire Pack — both
 * need the same "what will this do" sentence, and duplicating the switch would be exactly the
 * kind of drift `describeScopeRule`'s promotion (Phase A) already avoided for rule sentences.
 *
 * Pure: no React, no Prisma.
 */

import type { ScopeProposedEdit } from '@/lib/app/questionnaire/scope-evaluation/types';

export function describeScopeProposedEdit(op: ScopeProposedEdit): string {
  switch (op.op) {
    case 'edit_topic_criteria':
      return 'Rewrite the topic’s criteria';
    case 'edit_topic_depth':
      return `Change depth → ${op.depth}`;
    case 'add_rule':
      return `Add a rule: ${op.action} “${op.topicKey}” when “${op.dataSlotKey}” ${op.operator}${op.value ? ` “${op.value}”` : ''}`;
    case 'edit_rule':
      return `Rewrite this rule: ${op.action} “${op.topicKey}” when “${op.dataSlotKey}” ${op.operator}${op.value ? ` “${op.value}”` : ''}`;
    case 'delete_rule':
      return 'Delete this rule';
    case 'adjust_budget': {
      const parts: string[] = [];
      if (op.sessionBudgetSeconds !== undefined) parts.push(`budget → ${op.sessionBudgetSeconds}s`);
      if (op.maxOpeningProbes !== undefined) parts.push(`opening probes → ${op.maxOpeningProbes}`);
      if (op.maxConditionalTopics !== undefined)
        parts.push(`topic cap → ${op.maxConditionalTopics}`);
      return parts.join(', ') || 'Adjust the budget';
    }
    case 'edit_planner_instructions':
      return 'Replace the planner instructions';
    case 'add_fallback_topic':
      return `Add “${op.topicKey}” to the fallback set`;
  }
}
