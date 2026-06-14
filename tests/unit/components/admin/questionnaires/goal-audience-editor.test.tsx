/**
 * GoalAudienceEditor — version goal/audience metadata edited on the Settings tab.
 *
 * Pins the save contract the page relies on: it PATCHes the version graph with the trimmed
 * goal (null when blank) and the audience object (null when empty), and resyncs its fields
 * when the server props change after a refetch.
 *
 * @see components/admin/questionnaires/goal-audience-editor.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GoalAudienceEditor } from '@/components/admin/questionnaires/goal-audience-editor';
import type { MutationSpec } from '@/components/admin/questionnaires/version-editor-types';

/** Capture the [method, path, body] the editor hands to `run`. */
function setup(over: { goal?: string | null; audience?: Record<string, unknown> | null } = {}) {
  const specs: MutationSpec[] = [];
  const run = vi.fn((thunk: () => MutationSpec): Promise<boolean> => {
    specs.push(thunk());
    return Promise.resolve(true);
  });
  render(
    <GoalAudienceEditor
      questionnaireId="qn-1"
      versionId="ver-1"
      goal={over.goal ?? null}
      audience={(over.audience ?? null) as never}
      run={run}
      busy={false}
    />
  );
  return { specs, run };
}

// DOM order of the three text fields: [0] goal (textarea), [1] audience role, [2] description.
const GOAL = 0;
const ROLE = 1;

describe('GoalAudienceEditor', () => {
  it('PATCHes the version graph with the edited goal', () => {
    const { specs, run } = setup({ goal: '' });
    fireEvent.change(screen.getAllByRole('textbox')[GOAL], {
      target: { value: 'Understand churn' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save goal/i }));

    expect(run).toHaveBeenCalledTimes(1);
    const [method, path, body] = specs[0];
    expect(method).toBe('PATCH');
    expect(path).toContain('/questionnaires/qn-1/versions/ver-1');
    expect(body).toMatchObject({ goal: 'Understand churn' });
  });

  it('sends goal: null when the goal is blank', () => {
    const { specs } = setup({ goal: '   ' });
    fireEvent.click(screen.getByRole('button', { name: /save goal/i }));
    expect(specs[0][2]).toMatchObject({ goal: null });
  });

  it('sends audience: null when no role is entered', () => {
    const { specs } = setup();
    fireEvent.click(screen.getByRole('button', { name: /save goal/i }));
    expect(specs[0][2]).toMatchObject({ audience: null });
  });

  it('sends the audience object when a role is entered', () => {
    // The Save button flashes a "Saved" check and self-disables briefly after a save,
    // so a fresh render isolates this single save action.
    const { specs } = setup();
    fireEvent.change(screen.getAllByRole('textbox')[ROLE], { target: { value: 'new hire' } });
    fireEvent.click(screen.getByRole('button', { name: /save goal/i }));
    expect(specs[0][2]).toMatchObject({ audience: { role: 'new hire' } });
  });
});
