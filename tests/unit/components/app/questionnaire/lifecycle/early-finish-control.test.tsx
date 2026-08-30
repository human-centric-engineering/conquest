// @vitest-environment happy-dom

/**
 * EarlyFinishControl — the persistent "Continue or finish up" choice (F7.3).
 *
 * @see components/app/questionnaire/lifecycle/early-finish-control.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EarlyFinishControl } from '@/components/app/questionnaire/lifecycle/early-finish-control';

describe('EarlyFinishControl', () => {
  it('fires onFinish when the finish CTA is clicked', async () => {
    const onFinish = vi.fn();
    render(<EarlyFinishControl onFinish={onFinish} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /finish up & get my report/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('shows a finishing state and disables the buttons while busy', () => {
    render(<EarlyFinishControl onFinish={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: /finishing/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('collapses to a slim "Finish up now" link on Continue, without finishing', async () => {
    const onFinish = vi.fn();
    render(<EarlyFinishControl onFinish={onFinish} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // The choice never disappears — it just gets out of the way.
    expect(screen.queryByRole('region', { name: /continue or finish up/i })).toBeNull();
    expect(screen.getByRole('button', { name: /finish up now/i })).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('still finishes from the collapsed link', async () => {
    const onFinish = vi.fn();
    render(<EarlyFinishControl onFinish={onFinish} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await userEvent.click(screen.getByRole('button', { name: /finish up now/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('keeps the actions on their own row beneath the message at every width', () => {
    // The regression this guards: message and buttons sharing a row squeezed the sentence to one
    // word per line. Only the *pair* is responsive now — stacked full-width on a narrow banner,
    // side by side and trailing above 28rem — and it is keyed on the banner's own width
    // (`@container`), not the viewport's, because the chat column is what varies.
    render(<EarlyFinishControl onFinish={vi.fn()} busy={false} />);
    const region = screen.getByRole('region', { name: /continue or finish up/i });
    expect(region.className).toContain('@container');

    const [message, actions] = Array.from(region.firstElementChild?.children ?? []);
    const sentence = screen.getByText(/you can keep chatting/i);
    expect(message).toContainElement(sentence);
    // On the PARAGRAPH, which is where `flex-1` sat: sharing a row with two nowrap buttons, it was
    // the flex child that gave up its width. Asserting this on the wrapper would stay green while
    // the exact regression was reintroduced one element down.
    expect(sentence.className).not.toContain('flex-1');

    const cta = screen.getByRole('button', { name: /finish up & get my report/i });
    expect(actions).toContainElement(cta);
    expect(actions?.className).toContain('flex-col');
    expect(actions?.className).toContain('@md:flex-row');

    // The buttons fill the line when stacked, and shrink back to their labels once side by side.
    expect(cta.className).toContain('w-full');
    expect(cta.className).toContain('@md:w-auto');
  });
});
