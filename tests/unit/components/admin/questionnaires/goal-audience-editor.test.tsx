/**
 * GoalAudienceEditor — version goal/audience metadata, edited inline on the Structure tab.
 *
 * Pins the save contract the editor relies on: it PATCHes the version graph with the trimmed goal
 * (null when blank) and the audience object (null when empty), carries every audience field through,
 * drops cleared/invalid fields, reads back the closed-vocabulary selects, and only surfaces the
 * structure-review help when design eval is on.
 *
 * @see components/admin/questionnaires/goal-audience-editor.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GoalAudienceEditor } from '@/components/admin/questionnaires/goal-audience-editor';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import type { MutationSpec } from '@/components/admin/questionnaires/version-editor-types';

/** Capture the [method, path, body] the editor hands to `run`. */
function setup(
  over: { goal?: string | null; audience?: AudienceShape | null; designEvalEnabled?: boolean } = {}
) {
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
      audience={over.audience ?? null}
      run={run}
      busy={false}
      designEvalEnabled={over.designEvalEnabled ?? false}
    />
  );
  return { specs, run };
}

const clickSave = () => fireEvent.click(screen.getByRole('button', { name: /save goal/i }));
const bodyOf = (specs: MutationSpec[]) => specs[0][2] as { goal: unknown; audience: unknown };

describe('GoalAudienceEditor', () => {
  it('PATCHes the version graph with the edited goal', () => {
    const { specs, run } = setup({ goal: '' });
    fireEvent.change(screen.getByRole('textbox', { name: /Goal/ }), {
      target: { value: 'Understand churn' },
    });
    clickSave();

    expect(run).toHaveBeenCalledTimes(1);
    const [method, path, body] = specs[0];
    expect(method).toBe('PATCH');
    expect(path).toContain('/questionnaires/qn-1/versions/ver-1');
    expect(body).toMatchObject({ goal: 'Understand churn' });
  });

  it('sends goal: null when the goal is blank', () => {
    const { specs } = setup({ goal: '   ' });
    clickSave();
    expect(bodyOf(specs).goal).toBeNull();
  });

  it('sends audience: null when no audience fields are entered', () => {
    const { specs } = setup();
    clickSave();
    expect(bodyOf(specs).audience).toBeNull();
  });

  it('sends the full audience object with role, description, duration, locale, and notes', () => {
    const { specs } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: /Audience role/ }), {
      target: { value: 'new hire' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Audience description/ }), {
      target: { value: 'first-week joiners' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: /Est\. duration/ }), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Locale/ }), {
      target: { value: 'en-GB' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Audience notes/ }), {
      target: { value: 'be gentle' },
    });
    clickSave();

    expect(bodyOf(specs).audience).toEqual({
      role: 'new hire',
      description: 'first-week joiners',
      estimatedDurationMinutes: 8,
      locale: 'en-GB',
      notes: 'be gentle',
    });
  });

  it('drops a non-positive / non-numeric duration rather than sending it', () => {
    const { specs } = setup({ audience: { role: 'new hire' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: /Est\. duration/ }), {
      target: { value: '0' },
    });
    clickSave();
    expect(bodyOf(specs).audience).toEqual({ role: 'new hire' });
  });

  it('clearing the only audience field reverts to audience: null', () => {
    const { specs } = setup({ audience: { role: 'new hire' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Audience role/ }), {
      target: { value: '' },
    });
    clickSave();
    expect(bodyOf(specs).audience).toBeNull();
  });

  it('reads back the expertise + sensitivity selects from the stored audience', () => {
    setup({ audience: { expertiseLevel: 'expert', sensitivity: 'high' } });
    expect(screen.getByRole('combobox', { name: 'Expertise level' })).toHaveTextContent('Expert');
    expect(screen.getByRole('combobox', { name: 'Sensitivity' })).toHaveTextContent('High');
  });

  it('hides the structure-review help when design eval is off', () => {
    setup({ designEvalEnabled: false });
    expect(
      screen.queryByRole('button', { name: /how goal and audience are used/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/structure review on the Evaluations tab/)).not.toBeInTheDocument();
  });

  it('explains the structure review and lists the reviewers when design eval is on', () => {
    setup({ designEvalEnabled: true });
    expect(screen.getByText(/structure review on the Evaluations tab/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /how goal and audience are used/i }));
    expect(screen.getByText('Coverage')).toBeInTheDocument();
    expect(screen.getByText('Goal match')).toBeInTheDocument();
    expect(screen.getByText('Audience match')).toBeInTheDocument();
  });
});
