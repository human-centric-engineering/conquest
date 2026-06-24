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
});
