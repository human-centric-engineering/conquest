// @vitest-environment happy-dom

/**
 * MilestoneNotice — completeness-milestone side-band notice (F-progress).
 *
 * Covers: renders role="status" (not alert), shows the verbatim message, icon is
 * aria-hidden, and forwards an optional className.
 *
 * @see components/app/questionnaire/chat/milestone-notice.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MilestoneNotice } from '@/components/app/questionnaire/chat/milestone-notice';

describe('MilestoneNotice', () => {
  it('renders a role="status" container, not an alert', () => {
    render(<MilestoneNotice message="You're 50% of the way through." />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the verbatim message', () => {
    render(<MilestoneNotice message="You're 90% of the way through." />);
    expect(screen.getByText("You're 90% of the way through.")).toBeInTheDocument();
  });

  it('marks its icon aria-hidden so screen readers skip it', () => {
    render(<MilestoneNotice message="You're 25% of the way through." />);
    const svgs = document.querySelectorAll('svg[aria-hidden="true"]');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('forwards a custom className to the outer container', () => {
    render(<MilestoneNotice message="You're 75% of the way through." className="mt-4" />);
    expect(screen.getByRole('status')).toHaveClass('mt-4');
  });
});
