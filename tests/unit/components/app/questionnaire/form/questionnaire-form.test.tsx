/**
 * QuestionnaireForm — sectioned form rendering, completeness map, navigation, and the
 * inferred-answer affordance (P-presentation). Pins that the active section's questions
 * render, edits flow through onChange/onFlush, Next/Previous move sections, and an
 * agent-inferred answer is marked so the respondent can adjust it (the escape hatch).
 *
 * @see components/app/questionnaire/form/questionnaire-form.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { QuestionnaireForm } from '@/components/app/questionnaire/form/questionnaire-form';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

function slot(
  over: Partial<PanelSlotView> & Pick<PanelSlotView, 'slotKey' | 'prompt'>
): PanelSlotView {
  return {
    type: 'free_text',
    typeConfig: null,
    required: false,
    answered: false,
    value: null,
    provenance: null,
    confidence: null,
    rationale: null,
    respondentEdited: false,
    answeredAtTurnIndex: null,
    refinementHistory: [],
    ...over,
  };
}

function view(): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    answeredCount: 1,
    totalCount: 3,
    sections: [
      {
        sectionId: 's1',
        title: 'About you',
        slots: [
          slot({ slotKey: 'role', prompt: 'Your role?' }),
          slot({
            slotKey: 'team',
            prompt: 'Team size?',
            type: 'numeric',
            answered: true,
            value: 5,
            provenance: 'inferred',
            confidence: 0.45,
          }),
        ],
      },
      {
        sectionId: 's2',
        title: 'Your goals',
        slots: [slot({ slotKey: 'goal', prompt: 'Main goal?' })],
      },
    ],
  };
}

const noop = () => {};

describe('QuestionnaireForm', () => {
  it('renders the active section and the progress count', () => {
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText('Your role?')).toBeInTheDocument();
    expect(screen.getByText('Team size?')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument(); // overall progress header
    expect(screen.getByText('Section 1 of 2')).toBeInTheDocument();
  });

  it('marks an agent-captured answer with the adjust affordance', () => {
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    // The inferred 'team' answer surfaces a FieldHelp (ⓘ) the respondent can act on.
    expect(screen.getByLabelText('Captured answer — edit if needed')).toBeInTheDocument();
  });

  it('marks a directly-captured answer with the same affordance as an inferred one', () => {
    // Consistency fix: the ⓘ explainer is gated on "was this captured from the conversation",
    // NOT on provenance. A `direct` chat capture (the respondent stated it, but the agent still
    // read it off the transcript rather than the respondent typing it into the form) gets the same
    // "edit if it's not quite right" affordance as an `inferred`/`synthesised` one — otherwise the
    // icon appears on some captured answers and not others for no reason the respondent can see.
    const v = view();
    v.sections[0].slots[0] = slot({
      slotKey: 'role',
      prompt: 'Your role?',
      type: 'free_text',
      answered: true,
      value: 'I lead the sales enablement team',
      provenance: 'direct',
      confidence: 0.9,
    });
    render(
      <QuestionnaireForm
        view={v}
        loading={false}
        values={{ role: 'I lead the sales enablement team' }}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    // Both the direct 'role' and the inferred 'team' answer carry the explainer.
    expect(screen.getAllByLabelText('Captured answer — edit if needed')).toHaveLength(2);
  });

  it('surfaces the agent rationale inside the explainer when present', () => {
    const v = view();
    v.sections[0].slots[1].rationale = 'You mentioned a team of five in the kickoff.';
    render(
      <QuestionnaireForm
        view={v}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    fireEvent.click(screen.getByLabelText('Captured answer — edit if needed'));
    expect(screen.getByText('You mentioned a team of five in the kickoff.')).toBeInTheDocument();
  });

  it('does not show the explainer on a respondent-typed form answer', () => {
    // A form-typed answer (respondentEdited, confidence 1.0) still shows its confidence chip, but no
    // "captured from your conversation" explainer — the respondent knows they typed it themselves.
    const v = view();
    v.sections[0].slots[1] = slot({
      slotKey: 'team',
      prompt: 'Team size?',
      type: 'numeric',
      answered: true,
      value: 5,
      provenance: 'direct',
      confidence: 1,
      respondentEdited: true,
    });
    render(
      <QuestionnaireForm
        view={v}
        loading={false}
        values={{ team: 5 }}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.queryByLabelText('Captured answer — edit if needed')).not.toBeInTheDocument();
  });

  it('surfaces the confidence band on an agent-filled field', () => {
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    // The inferred 'team' answer (confidence 0.45) shows a "Tentative" chip so the respondent
    // knows it's a guess to glance at; the un-inferred 'role' field shows no chip.
    expect(screen.getByText(/tentative/i)).toBeInTheDocument();
  });

  it('keeps the confidence band when the inferred answer is only seeded, not edited', () => {
    // Regression: the form seeds `values` with EVERY existing answer so the inputs render. A
    // seeded inferred answer (here `team`) must still show its confidence — the marker drops on a
    // respondent EDIT (`editedKeys`), not merely on the value being present.
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{ team: 7 }} // seeded from the server on form load (not a respondent edit)
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText(/tentative/i)).toBeInTheDocument();
  });

  it('shows the confidence band on a directly-stated free-text answer (always a paraphrase)', () => {
    // Free-text answers are the agent's paraphrase of what the respondent said, so they carry a
    // meaningful capture confidence even at provenance 'direct' — the chip must surface.
    const v = view();
    v.sections[0].slots[0] = slot({
      slotKey: 'role',
      prompt: 'Your role?',
      type: 'free_text',
      answered: true,
      value: 'I lead the sales enablement team',
      provenance: 'direct',
      confidence: 0.9,
    });
    render(
      <QuestionnaireForm
        view={v}
        loading={false}
        values={{ role: 'I lead the sales enablement team' }}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText(/confident/i)).toBeInTheDocument();
  });

  it('shows the confidence band on a directly-stated structured (numeric) answer', () => {
    // Every answered, scored question carries the band regardless of provenance — a directly stated
    // likert/numeric value still shows how sure the capture was.
    const v = view();
    v.sections[0].slots[1] = slot({
      slotKey: 'team',
      prompt: 'Team size?',
      type: 'numeric',
      answered: true,
      value: 5,
      provenance: 'direct',
      confidence: 0.9,
    });
    render(
      <QuestionnaireForm
        view={v}
        loading={false}
        values={{ team: 5 }}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText(/confident/i)).toBeInTheDocument();
  });

  it('keeps the confidence band on an answer the respondent has edited (rating stays on it)', () => {
    // The band belongs to the answer, not to "is it still the agent's" — so it persists after an
    // edit. (Only the "inferred" marker drops on edit; see the test below.)
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{ team: 8 }}
        editedKeys={new Set(['team'])}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText(/tentative/i)).toBeInTheDocument();
  });

  it('drops the captured-answer marker once the respondent edits the field', () => {
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{ team: 7 }}
        editedKeys={new Set(['team'])}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.queryByLabelText('Captured answer — edit if needed')).not.toBeInTheDocument();
  });

  it('gently pulses the answer block filled by the most recent turn', () => {
    const v = view();
    // 'team' carries the max answeredAtTurnIndex → it's the latest-turn fill; 'role' has none.
    v.sections[0].slots[1].answeredAtTurnIndex = 2;
    render(
      <QuestionnaireForm
        view={v}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    // One-shot wash (settles to a resting tint), not the infinite `cq-fill-glow` breathe.
    expect(screen.getByText('Team size?').closest('li')?.className).toContain('cq-fill-glow-once');
    expect(screen.getByText('Your role?').closest('li')?.className).not.toContain('cq-fill-glow');
  });

  it('navigates to the next section', () => {
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Main goal?')).toBeInTheDocument();
    expect(screen.getByText('Section 2 of 2')).toBeInTheDocument();
  });

  it('reports edits through onChange', () => {
    const onChange = vi.fn();
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={onChange}
        onFlush={noop}
      />
    );
    fireEvent.change(screen.getAllByPlaceholderText('Type your answer…')[0], {
      target: { value: 'Engineer' },
    });
    expect(onChange).toHaveBeenCalledWith('role', 'Engineer');
  });

  it('shows a loading message before the view arrives', () => {
    render(
      <QuestionnaireForm
        view={null}
        loading
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText('Loading questionnaire…')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no questions', () => {
    render(
      <QuestionnaireForm
        view={{
          status: 'active',
          scope: 'full_progress',
          sections: [],
          answeredCount: 0,
          totalCount: 0,
        }}
        loading={false}
        values={{}}
        statuses={{}}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText('This questionnaire has no questions yet.')).toBeInTheDocument();
  });

  it('shows the persistent autosave indicator reflecting the aggregate save state', () => {
    const { rerender } = render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        saveState="idle"
        lastSavedAt={null}
        onChange={noop}
        onFlush={noop}
      />
    );
    // Idle: reassures that there's no Save button to hunt for.
    expect(screen.getByText('Changes save automatically')).toBeInTheDocument();
    rerender(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{}}
        statuses={{}}
        saveState="saved"
        lastSavedAt={Date.now()}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('surfaces a per-slot save status hint', () => {
    render(
      <QuestionnaireForm
        view={view()}
        loading={false}
        values={{ role: 'Eng' }}
        statuses={{ role: 'saving' }}
        onChange={noop}
        onFlush={noop}
      />
    );
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });
});
