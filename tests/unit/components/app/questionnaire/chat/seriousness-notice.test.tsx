/**
 * SeriousnessNotice Tests
 *
 * Covers: renders role="status" container, always shows the fixed heading,
 * renders the message prop, icon is aria-hidden, optional className is forwarded.
 *
 * @see components/app/questionnaire/chat/seriousness-notice.tsx
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';

import { SeriousnessNotice } from '@/components/app/questionnaire/chat/seriousness-notice';

afterEach(() => {
  // Explicit cleanup guarantees the DOM is torn down between tests regardless of RTL's
  // auto-cleanup registration order — under the full parallel suite that ordering can race and
  // leave stale nodes, which made global `screen`/`document` queries here intermittently flaky.
  cleanup();
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

  describe('heading', () => {
    it('renders the "Let\'s keep it genuine" heading on a normal (amber) warning', () => {
      // Arrange / Act
      render(<SeriousnessNotice message="Any message." />);

      // Assert: default (non-final) heading.
      expect(screen.getByText("Let's keep it genuine")).toBeInTheDocument();
    });

    it('escalates to a red "Final warning" heading on the final strike', () => {
      // Arrange / Act — scope queries to the render container so a stale prior render can't be matched.
      const { container } = render(<SeriousnessNotice message="Any message." final />);
      const scoped = within(container);

      // Assert: the last warning before abandonment reads "Final warning" and is tinted red.
      const heading = scoped.getByText('Final warning');
      expect(heading).toBeInTheDocument();
      expect(scoped.queryByText("Let's keep it genuine")).toBeNull();
      expect(heading.className).toMatch(/text-red-700/);
      // The container itself switches to the red palette.
      expect(scoped.getByRole('status').className).toMatch(/border-red-400/);
    });

    it('renders the **bold** consequence in red on the final warning', () => {
      // Arrange / Act
      const { container } = render(
        <SeriousnessNotice message="Set aside. **One more and this will be aborted.**" final />
      );

      // Assert: the emphasised run is a red <strong> (scoped to this render).
      const strong = within(container).getByText('One more and this will be aborted.');
      expect(strong.tagName).toBe('STRONG');
      expect(strong.className).toMatch(/text-red-700/);
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
      // Arrange / Act — scope to this render's container, not the global document.
      const { container } = render(<SeriousnessNotice message="Please answer genuinely." />);

      // Assert: the SVG icon carries aria-hidden="true" so screen readers skip it.
      // Lucide renders the icon as an <svg>; aria-hidden makes it invisible to the tree.
      const svgs = container.querySelectorAll('svg[aria-hidden="true"]');
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
