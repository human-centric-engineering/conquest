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
import { MessageSquare, ListChecks } from 'lucide-react';

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

  it('slides the indicator to the second segment when the value is form', () => {
    const { container } = render(<ModeToggle value="form" onChange={() => {}} />);
    // The indicator offset is computed from the active index (segment 2 of 2 → 100% of its width).
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.getAttribute('style')).toContain('translateX(100%)');
  });

  it('keeps the indicator on the first segment when the value is chat', () => {
    const { container } = render(<ModeToggle value="chat" onChange={() => {}} />);
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.getAttribute('style')).toContain('translateX(0%)');
  });

  it('renders a third segment and tracks it when supplied custom items', () => {
    const onChange = vi.fn();
    const items = [
      { id: 'intro', label: 'Intro', Icon: MessageSquare },
      { id: 'chat', label: 'Chat', Icon: MessageSquare },
      { id: 'form', label: 'Form', Icon: ListChecks },
    ];
    const { container } = render(<ModeToggle value="form" onChange={onChange} items={items} />);
    expect(screen.getByRole('tab', { name: 'Intro' })).toBeInTheDocument();
    // Third of three segments → translated two widths across.
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.getAttribute('style')).toContain('translateX(200%)');
    fireEvent.click(screen.getByRole('tab', { name: 'Intro' }));
    expect(onChange).toHaveBeenCalledWith('intro');
  });
});
