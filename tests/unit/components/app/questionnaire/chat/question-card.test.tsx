/**
 * QuestionCard — the in-chat answer control (P18 phase 3).
 *
 * Pins the behaviour a respondent actually depends on: the wording is verbatim, the right control is
 * rendered for the type, Submit can't fire on an empty answer, a successful submit writes through
 * the existing `PUT …/answers` path, and the escape hatch hands them back to the composer WITHOUT
 * marking the question answered.
 *
 * @see components/app/questionnaire/chat/question-card.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const submit = vi.fn();
const hookState = { saving: false, error: false };
vi.mock('@/lib/hooks/use-inline-correction', () => ({
  useInlineCorrection: () => ({ saving: hookState.saving, error: hookState.error, submit }),
}));

import { QuestionCard } from '@/components/app/questionnaire/chat/question-card';
import type { QuestionCardPayload } from '@/lib/app/questionnaire/chat/question-card';

const LIKERT: QuestionCardPayload = {
  questionKey: 'workload',
  prompt: 'How satisfied are you with your current workload?',
  type: 'likert',
  typeConfig: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Extremely' },
  required: true,
  reason: 'must_ask',
};

function setup(card: QuestionCardPayload = LIKERT, over: Record<string, unknown> = {}) {
  const onAnswered = vi.fn();
  const onDismiss = vi.fn();
  render(
    <QuestionCard
      card={card}
      sessionId="sess-1"
      onAnswered={onAnswered}
      onDismiss={onDismiss}
      {...over}
    />
  );
  return { onAnswered, onDismiss };
}

beforeEach(() => {
  submit.mockReset();
  hookState.saving = false;
  hookState.error = false;
});

describe('QuestionCard', () => {
  it('renders the prompt verbatim', () => {
    // The whole point of the card: this is the instrument, shown exactly as authored.
    setup();
    expect(screen.getByText(LIKERT.prompt)).toBeInTheDocument();
  });

  it('marks a must-ask card as asked as written, and shows the required flag', () => {
    setup();
    expect(screen.getByText(/asked as written/i)).toBeInTheDocument();
    expect(screen.getByText(/required/i)).toBeInTheDocument();
  });

  it('uses neutral copy for a last-resort card', () => {
    // A rescue must not be labelled a deliberate design, or the respondent reads the fallback as
    // the author's intent.
    setup({ ...LIKERT, reason: 'last_resort', required: false });
    expect(screen.getByText(/answer directly/i)).toBeInTheDocument();
    expect(screen.queryByText(/asked as written/i)).not.toBeInTheDocument();
  });

  it('renders the scale for a likert question', () => {
    setup();
    expect(screen.getByRole('radio', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5' })).toBeInTheDocument();
  });

  it('renders the choices for a single-choice question', () => {
    setup({
      ...LIKERT,
      type: 'single_choice',
      typeConfig: {
        choices: [
          { value: 'a', label: 'Very easy' },
          { value: 'b', label: 'Very hard' },
        ],
      },
    });
    expect(screen.getByText('Very easy')).toBeInTheDocument();
    expect(screen.getByText('Very hard')).toBeInTheDocument();
  });

  it('keeps Submit disabled until an answer is given', async () => {
    // Submitting nothing would write an empty value over the question and count it answered.
    setup();
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: '4' }));
    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();
  });

  it('writes the chosen value through the answers endpoint', async () => {
    setup();
    await userEvent.click(screen.getByRole('radio', { name: '4' }));
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(submit).toHaveBeenCalledWith([{ questionKey: 'workload', value: 4 }]);
  });

  it('treats an untouched multi-choice as empty, and a ticked one as answered', async () => {
    // The empty check runs per shape. Getting the array case wrong would let Submit fire on `[]`,
    // recording "answered nothing" for a question the respondent never touched.
    setup({
      ...LIKERT,
      type: 'multi_choice',
      typeConfig: {
        choices: [
          { value: 'a', label: 'Mornings' },
          { value: 'b', label: 'Evenings' },
        ],
      },
    });
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /mornings/i }));
    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(submit).toHaveBeenCalledWith([{ questionKey: 'workload', value: ['a'] }]);
  });

  it('treats a string-valued control as empty until it holds a value', async () => {
    // `date` yields a string. The empty check runs per shape; getting the string case wrong would
    // let Submit fire on '' and record a blank as the answer.
    setup({ ...LIKERT, type: 'date', typeConfig: null, required: false });
    const input = screen.getByDisplayValue('');
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();

    fireEvent.change(input, { target: { value: '2026-03-01' } });
    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('treats an untouched matrix grid as empty', () => {
    // A matrix value is a per-row record; an untouched grid is `{}`.
    setup({
      ...LIKERT,
      type: 'matrix',
      typeConfig: { rows: [{ key: 'r1', label: 'Pay' }], scale: { min: 1, max: 5 } },
    });
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('offers the escape hatch and does not submit when it is taken', async () => {
    // Dismissing hands them back to the composer; the question stays outstanding so the interviewer
    // returns to it, which is why this can't be used to dodge a required item.
    const { onDismiss } = setup();
    await userEvent.click(screen.getByRole('button', { name: /my own words/i }));

    expect(onDismiss).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('locks every control while saving', () => {
    hookState.saving = true;
    setup();
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /my own words/i })).toBeDisabled();
  });

  it('surfaces a save failure without losing the respondent’s choice', async () => {
    // A failed save must leave them able to retry with the SAME selection — clearing it would make
    // a transient network error cost them the answer they just gave.
    hookState.error = true;
    setup();

    await userEvent.click(screen.getByRole('radio', { name: '4' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    expect(screen.getByRole('radio', { name: '4' })).toBeChecked();
    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();
  });
});
