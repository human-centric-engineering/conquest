/**
 * SessionComplete — the post-submission confirmation (F7.3).
 *
 * @see components/app/questionnaire/lifecycle/session-complete.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';

describe('SessionComplete', () => {
  it('shows the thank-you heading', () => {
    render(<SessionComplete answeredCount={null} />);
    expect(
      screen.getByRole('heading', { name: /your responses are submitted/i })
    ).toBeInTheDocument();
  });

  it('acknowledges the captured-answer count when known', () => {
    render(<SessionComplete answeredCount={5} />);
    expect(screen.getByText(/captured 5 answers/i)).toBeInTheDocument();
  });

  it('singularises one captured answer', () => {
    render(<SessionComplete answeredCount={1} />);
    expect(screen.getByText(/captured 1 answer\b/i)).toBeInTheDocument();
  });

  it('falls back to a generic close when the count is zero/unknown', () => {
    render(<SessionComplete answeredCount={0} />);
    expect(screen.getByText(/nothing more you need to do/i)).toBeInTheDocument();
  });
});
