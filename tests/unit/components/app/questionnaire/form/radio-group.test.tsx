/**
 * RadioGroup — app-local single-select control (P-presentation). Pins: renders an option per
 * entry, reflects the selected value, emits on change, and respects the disabled state.
 *
 * @see components/app/questionnaire/form/radio-group.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { RadioGroup } from '@/components/app/questionnaire/form/radio-group';

const OPTIONS = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
];

describe('RadioGroup', () => {
  it('renders an option per entry and checks the selected one', () => {
    render(<RadioGroup name="fruit" options={OPTIONS} value="b" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Banana' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Apple' })).not.toBeChecked();
  });

  it('emits the chosen value on change', () => {
    const onChange = vi.fn();
    render(<RadioGroup name="fruit" options={OPTIONS} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Apple' }));
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('disables every option when disabled', () => {
    render(<RadioGroup name="fruit" options={OPTIONS} value={null} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('radio', { name: 'Apple' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Banana' })).toBeDisabled();
  });
});
