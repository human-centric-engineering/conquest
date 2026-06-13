/**
 * QuestionField — renders the right control per question type and emits normalised values
 * (P-presentation). Pins the per-type contract the autosave + server validation rely on:
 * likert/numeric emit numbers, boolean emits a real boolean, single/multi choice emit the
 * choice value(s), and an emptied control emits an "empty" the form turns into a clear.
 *
 * @see components/app/questionnaire/form/question-field.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { QuestionField } from '@/components/app/questionnaire/form/question-field';
import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';
import type { QuestionType } from '@/lib/app/questionnaire/types';

function slot(
  type: QuestionType,
  typeConfig: unknown = null,
  over: Partial<PanelSlotView> = {}
): PanelSlotView {
  return {
    slotKey: 'q1',
    prompt: 'A question?',
    type,
    typeConfig,
    required: false,
    answered: false,
    value: null,
    provenance: null,
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: null,
    refinementHistory: [],
    ...over,
  };
}

describe('QuestionField', () => {
  it('free_text: emits the typed string', () => {
    const onChange = vi.fn();
    render(<QuestionField slot={slot('free_text')} value="" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Hello' },
    });
    expect(onChange).toHaveBeenCalledWith('Hello');
  });

  it('likert: renders a button per point (incl. negatives) and emits the number', () => {
    const onChange = vi.fn();
    render(
      <QuestionField slot={slot('likert', { min: -2, max: 2 })} value={null} onChange={onChange} />
    );
    // −2..+2 → 5 buttons.
    expect(screen.getByRole('radio', { name: '-2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('numeric: emits a number, and undefined when cleared', () => {
    const onChange = vi.fn();
    render(
      <QuestionField slot={slot('numeric', { min: 0, max: 100 })} value={5} onChange={onChange} />
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '42' } });
    expect(onChange).toHaveBeenCalledWith(42);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('boolean: emits a real boolean for the Yes/No options', () => {
    const onChange = vi.fn();
    render(<QuestionField slot={slot('boolean')} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Yes'));
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('No'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('single_choice: emits the selected choice value', () => {
    const onChange = vi.fn();
    const cfg = {
      choices: [
        { value: 'r', label: 'Red' },
        { value: 'b', label: 'Blue' },
      ],
    };
    render(<QuestionField slot={slot('single_choice', cfg)} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Blue'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('multi_choice: toggles values into an array', () => {
    const onChange = vi.fn();
    const cfg = {
      choices: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    };
    render(<QuestionField slot={slot('multi_choice', cfg)} value={['a']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('B'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
  });

  it('date: emits the ISO date string', () => {
    const onChange = vi.fn();
    const { container } = render(
      <QuestionField slot={slot('date')} value="" onChange={onChange} />
    );
    const input = container.querySelector('input[type="date"]')!;
    fireEvent.change(input, { target: { value: '2026-06-13' } });
    expect(onChange).toHaveBeenCalledWith('2026-06-13');
  });

  it('likert: falls back to a numeric input when the config is malformed', () => {
    const onChange = vi.fn();
    // max ≤ min → readLikertConfig returns null → numeric fallback.
    render(
      <QuestionField slot={slot('likert', { min: 5, max: 1 })} value={null} onChange={onChange} />
    );
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('single_choice (allowOther): Other reveals a free-text input that emits', () => {
    const onChange = vi.fn();
    const cfg = {
      choices: [
        { value: 'r', label: 'Red' },
        { value: 'b', label: 'Blue' },
      ],
      allowOther: true,
    };
    const { rerender } = render(
      <QuestionField slot={slot('single_choice', cfg)} value={null} onChange={onChange} />
    );
    fireEvent.click(screen.getByLabelText('Other…'));
    expect(onChange).toHaveBeenCalledWith(''); // selecting Other clears to an empty free value
    // A non-choice value renders the free-text input, which emits what's typed.
    rerender(
      <QuestionField slot={slot('single_choice', cfg)} value="custom" onChange={onChange} />
    );
    fireEvent.change(screen.getByPlaceholderText('Your answer…'), { target: { value: 'Teal' } });
    expect(onChange).toHaveBeenCalledWith('Teal');
  });

  it('multi_choice (allowOther): typing in the other box appends a free value', () => {
    const onChange = vi.fn();
    const cfg = {
      choices: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      allowOther: true,
    };
    render(<QuestionField slot={slot('multi_choice', cfg)} value={['a']} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('Other…'), { target: { value: 'Custom' } });
    expect(onChange).toHaveBeenCalledWith(['a', 'Custom']);
  });

  it('renders a "no options" notice when a choice config is missing', () => {
    render(<QuestionField slot={slot('single_choice', null)} value={null} onChange={vi.fn()} />);
    expect(screen.getByText('No options configured.')).toBeInTheDocument();
  });

  it('passes the disabled state to the control', () => {
    render(<QuestionField slot={slot('free_text')} value="" onChange={vi.fn()} disabled />);
    expect(screen.getByPlaceholderText('Type your answer…')).toBeDisabled();
  });
});
