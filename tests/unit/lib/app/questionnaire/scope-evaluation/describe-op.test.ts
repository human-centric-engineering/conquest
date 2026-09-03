/**
 * Unit tests for `describeScopeProposedEdit` (F17.21) — the plain-English rendering of a
 * `ScopeProposedEdit`, shared by the admin review card and the Questionnaire Pack. One case per
 * op, since the switch has no default and a missing case is a compile error, not a runtime one —
 * these pin the actual wording rather than just "it doesn't throw".
 */

import { describe, expect, it } from 'vitest';

import { describeScopeProposedEdit } from '@/lib/app/questionnaire/scope-evaluation';
import type { ScopeProposedEdit } from '@/lib/app/questionnaire/scope-evaluation';

describe('describeScopeProposedEdit', () => {
  it('describes edit_topic_criteria', () => {
    expect(
      describeScopeProposedEdit({ op: 'edit_topic_criteria', criteria: 'New criteria text' })
    ).toBe('Rewrite the topic’s criteria');
  });

  it('describes edit_topic_depth', () => {
    expect(describeScopeProposedEdit({ op: 'edit_topic_depth', depth: 'light' })).toBe(
      'Change depth → light'
    );
  });

  it('describes adjust_budget with every field set', () => {
    const op: ScopeProposedEdit = {
      op: 'adjust_budget',
      sessionBudgetSeconds: 600,
      maxOpeningProbes: 2,
      maxConditionalTopics: 4,
    };
    expect(describeScopeProposedEdit(op)).toBe('budget → 600s, opening probes → 2, topic cap → 4');
  });

  it('describes adjust_budget with only one field set', () => {
    expect(describeScopeProposedEdit({ op: 'adjust_budget', maxConditionalTopics: 5 })).toBe(
      'topic cap → 5'
    );
  });

  it('falls back to a generic description for adjust_budget with no field set', () => {
    // Not expected to reach the UI (the Zod schema requires at least one field), but the
    // renderer must not crash or print an empty string on a malformed override.
    expect(describeScopeProposedEdit({ op: 'adjust_budget' })).toBe('Adjust the budget');
  });

  it('describes edit_planner_instructions', () => {
    expect(
      describeScopeProposedEdit({
        op: 'edit_planner_instructions',
        plannerInstructions: 'Prefer breadth over depth.',
      })
    ).toBe('Replace the planner instructions');
  });

  it('describes add_fallback_topic', () => {
    expect(describeScopeProposedEdit({ op: 'add_fallback_topic', topicKey: 'compliance' })).toBe(
      'Add “compliance” to the fallback set'
    );
  });
});
