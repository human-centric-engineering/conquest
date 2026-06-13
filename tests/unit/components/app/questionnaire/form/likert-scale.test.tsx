/**
 * LikertScale — discrete integer rating control (P-presentation). Pins: a button per point
 * across the (possibly negative) range, endpoint labels, selection emit, the selected state, the
 * disabled state, and the malformed-range guard (renders nothing).
 *
 * @see components/app/questionnaire/form/likert-scale.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { LikertScale } from '@/components/app/questionnaire/form/likert-scale';

describe('LikertScale', () => {
  it('renders one button per point (inclusive, negatives) and emits the clicked value', () => {
    const onChange = vi.fn();
    render(<LikertScale min={-2} max={2} value={null} onChange={onChange} />);
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    fireEvent.click(screen.getByRole('radio', { name: '-1' }));
    expect(onChange).toHaveBeenCalledWith(-1);
  });

  it('shows endpoint labels and marks the selected point', () => {
    render(
      <LikertScale min={1} max={5} minLabel="Low" maxLabel="High" value={3} onChange={vi.fn()} />
    );
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '3' })).toHaveAttribute('aria-checked', 'true');
  });

  it('renders nothing for a malformed range (max ≤ min)', () => {
    const { container } = render(<LikertScale min={5} max={1} value={null} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not emit when disabled', () => {
    const onChange = vi.fn();
    render(<LikertScale min={1} max={3} value={null} onChange={onChange} disabled />);
    const btn = screen.getByRole('radio', { name: '2' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });
});
