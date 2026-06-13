/**
 * ModeToggle — the compact chat ↔ form segmented switch (P-presentation).
 *
 * Pins the contract the workspace relies on: two tabs, the active one marked
 * aria-selected, a click reports the target view, and the sliding indicator tracks the value.
 *
 * @see components/app/questionnaire/mode-toggle.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ModeToggle } from '@/components/app/questionnaire/mode-toggle';

describe('ModeToggle', () => {
  it('renders Chat + Form tabs with the active one selected', () => {
    render(<ModeToggle value="chat" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'false');
  });

  it('reports the target view on click', () => {
    const onChange = vi.fn();
    render(<ModeToggle value="chat" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(onChange).toHaveBeenCalledWith('form');
  });

  it('slides the indicator to the right when the value is form', () => {
    const { container } = render(<ModeToggle value="form" onChange={() => {}} />);
    // The aria-hidden indicator carries the translate class only when form is active.
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.className).toContain('translate-x-full');
  });
});
