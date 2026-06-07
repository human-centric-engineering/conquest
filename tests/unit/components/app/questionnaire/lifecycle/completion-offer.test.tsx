/**
 * CompletionOffer — Submit CTA, busy state, and dismiss (F7.3).
 *
 * @see components/app/questionnaire/lifecycle/completion-offer.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CompletionOffer } from '@/components/app/questionnaire/lifecycle/completion-offer';

describe('CompletionOffer', () => {
  it('fires onSubmit when the Submit button is clicked', async () => {
    const onSubmit = vi.fn();
    render(<CompletionOffer onSubmit={onSubmit} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /submit responses/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a submitting state and disables the buttons while busy', () => {
    render(<CompletionOffer onSubmit={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /keep going/i })).toBeDisabled();
  });

  it('dismisses itself on "Keep going" without submitting', async () => {
    const onSubmit = vi.fn();
    const { container } = render(<CompletionOffer onSubmit={onSubmit} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /keep going/i }));
    expect(container.firstChild).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
