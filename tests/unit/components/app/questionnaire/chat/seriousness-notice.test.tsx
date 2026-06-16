/**
 * SeriousnessNotice Tests
 *
 * Covers: renders role="status" container, always shows the fixed heading,
 * renders the message prop, icon is aria-hidden, optional className is forwarded.
 *
 * @see components/app/questionnaire/chat/seriousness-notice.tsx
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SeriousnessNotice } from '@/components/app/questionnaire/chat/seriousness-notice';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SeriousnessNotice', () => {
  describe('container accessibility role', () => {
    it('renders a role="status" container', () => {
      // Arrange / Act
      render(<SeriousnessNotice message="Please answer genuinely." />);

      // Assert: polite status region (not role="alert") so screen readers don't interrupt.
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('does NOT render a role="alert" container', () => {
      // Arrange / Act
      render(<SeriousnessNotice message="Please answer genuinely." />);

      // Assert: cautionary nudge uses polite status, not assertive alert.
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('fixed heading', () => {
    it('always renders the "Let\'s keep it genuine" heading', () => {
      // Arrange / Act
      render(<SeriousnessNotice message="Any message." />);

      // Assert: heading copy is static regardless of the message prop.
      expect(screen.getByText("Let's keep it genuine")).toBeInTheDocument();
    });
  });

  describe('message prop', () => {
    it('renders the provided message text', () => {
      // Arrange
      const message = 'We noticed that response was a bit playful — please try again seriously.';

      // Act
      render(<SeriousnessNotice message={message} />);

      // Assert: the agent-supplied warning text appears verbatim.
      expect(screen.getByText(message)).toBeInTheDocument();
    });

    it('renders a different message when the prop changes between renders', () => {
      // Arrange
      const { rerender } = render(<SeriousnessNotice message="First message." />);

      // Act
      rerender(<SeriousnessNotice message="Second escalated message." />);

      // Assert: new message is visible; old one is gone.
      expect(screen.getByText('Second escalated message.')).toBeInTheDocument();
      expect(screen.queryByText('First message.')).toBeNull();
    });

    it('renders **bold** segments as <strong> (the penultimate-strike last-chance warning)', () => {
      // Arrange: the final warning wraps its consequence sentence in ** ** markers.
      render(<SeriousnessNotice message="Set aside for now. **One more will end the session.**" />);

      // Assert: the emphasised run is a <strong>, and the markers themselves are not shown.
      const strong = screen.getByText('One more will end the session.');
      expect(strong.tagName).toBe('STRONG');
      expect(screen.queryByText(/\*\*/)).toBeNull();
    });
  });

  describe('ShieldAlert icon', () => {
    it('renders an element marked aria-hidden to exclude the icon from the a11y tree', () => {
      // Arrange / Act
      render(<SeriousnessNotice message="Please answer genuinely." />);

      // Assert: the SVG icon carries aria-hidden="true" so screen readers skip it.
      // Lucide renders the icon as an <svg>; aria-hidden makes it invisible to the tree.
      const svgs = document.querySelectorAll('svg[aria-hidden="true"]');
      expect(svgs.length).toBeGreaterThan(0);
    });
  });

  describe('optional className', () => {
    it('forwards a custom className to the outer container', () => {
      // Arrange / Act
      render(<SeriousnessNotice message="Any message." className="my-custom-class" />);

      // Assert: the extra class is applied so callers can adjust spacing/layout.
      expect(screen.getByRole('status')).toHaveClass('my-custom-class');
    });

    it('renders without error when className is omitted', () => {
      // Arrange / Act / Assert: no className → no crash and container still exists.
      render(<SeriousnessNotice message="Any message." />);
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });
});
