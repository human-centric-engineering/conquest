// @vitest-environment happy-dom

/**
 * SessionProgressBar — weighted-coverage bar for the respondent surface (F7.3).
 *
 * Covers percentage rounding, the [0, 1] clamp on out-of-range coverage, the
 * "{pct}% completed" label, and the progressbar ARIA contract.
 *
 * @see components/app/questionnaire/session-progress-bar.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SessionProgressBar } from '@/components/app/questionnaire/session-progress-bar';

describe('SessionProgressBar', () => {
  it('rounds coverage to a whole-percent label', () => {
    render(<SessionProgressBar coverage={0.426} />);
    expect(screen.getByText('43% completed')).toBeInTheDocument();
  });

  it('exposes the rounded value through the progressbar ARIA contract', () => {
    render(<SessionProgressBar coverage={0.5} />);
    const bar = screen.getByRole('progressbar', { name: 'Questionnaire progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps coverage above 1 to 100%', () => {
    render(<SessionProgressBar coverage={1.8} />);
    expect(screen.getByText('100% completed')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('clamps negative coverage to 0%', () => {
    render(<SessionProgressBar coverage={-0.5} />);
    expect(screen.getByText('0% completed')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('applies a passed className to the wrapper', () => {
    const { container } = render(<SessionProgressBar coverage={0.3} className="mt-4" />);
    expect(container.firstChild).toHaveClass('mt-4');
  });

  it('shows the percent-completed text by default', () => {
    render(<SessionProgressBar coverage={0.5} />);
    expect(screen.getByText('50% completed')).toBeInTheDocument();
  });

  it('hides the percent-completed text when showPercentText is false, keeping the bar itself', () => {
    render(<SessionProgressBar coverage={0.5} showPercentText={false} />);
    expect(screen.queryByText(/completed/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });
});

/**
 * `sharesLine` — the caption stands down rather than printing on top of its neighbour.
 *
 * On the lifecycle strip the bar is `flex-1` beside a `shrink-0` reference chip, so under about
 * 450px the bar's box shrinks past its own caption. The caption is `shrink-0`, so it neither wraps
 * nor truncates: it overflows, and "0% completed" was rendering straight through "Ref: HY26-91TE".
 *
 * jsdom computes no layout and evaluates no media query, so the declaration is the assertion. What
 * makes it worth having is the pair of properties underneath: the caption goes, the ARIA value
 * stays, so nothing a screen reader relies on is riding on a visual breakpoint.
 */
describe('sharing a line', () => {
  it('puts the caption behind a breakpoint when the bar shares its line', () => {
    render(<SessionProgressBar coverage={0.5} sharesLine />);
    const caption = screen.getByText('50% completed');
    expect(caption).toHaveClass('hidden');
    expect(caption).toHaveClass('sm:inline');
  });

  it('keeps the caption unconditional when the bar owns its line', () => {
    // The default. A bar in the chat header or the standalone `progress` slot has the room.
    render(<SessionProgressBar coverage={0.5} />);
    expect(screen.getByText('50% completed')).not.toHaveClass('hidden');
  });

  it('never sheds the value itself — that lives on the bar, not the caption', () => {
    render(<SessionProgressBar coverage={0.5} sharesLine />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'Questionnaire progress');
  });
});
