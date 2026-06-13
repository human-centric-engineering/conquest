/**
 * SupportNotice Tests
 *
 * Covers: renders role="status" container, always shows the fixed heading,
 * renders message text without a URL, splits a trailing URL into a real <a> link
 * (correct href, target="_blank", rel="noopener noreferrer"), does not render an
 * <a> when the message has no trailing URL, icon is aria-hidden.
 *
 * @see components/app/questionnaire/chat/support-notice.tsx
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SupportNotice } from '@/components/app/questionnaire/chat/support-notice';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SupportNotice', () => {
  describe('container accessibility role', () => {
    it('renders a role="status" container', () => {
      // Arrange / Act
      render(<SupportNotice message="Support is here for you." />);

      // Assert: polite status region so screen readers don't interrupt the conversation.
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('does NOT render a role="alert" container', () => {
      // Arrange / Act
      render(<SupportNotice message="Support is here for you." />);

      // Assert: gentle supportive tone — not assertive alert.
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('fixed heading', () => {
    it('always renders the "Support is available" heading', () => {
      // Arrange / Act
      render(<SupportNotice message="Any message." />);

      // Assert: heading copy is static regardless of the message prop.
      expect(screen.getByText('Support is available')).toBeInTheDocument();
    });
  });

  describe('message without a trailing URL', () => {
    it('renders the full message text when no URL is present', () => {
      // Arrange
      const message = 'Our team is available 24/7 to help you.';

      // Act
      render(<SupportNotice message={message} />);

      // Assert: verbatim message copy appears.
      expect(screen.getByText(message)).toBeInTheDocument();
    });

    it('does NOT render an anchor element when the message contains no URL', () => {
      // Arrange / Act
      render(<SupportNotice message="Talk to someone you trust." />);

      // Assert: no link is injected when the author did not supply one.
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('message with a trailing URL', () => {
    it('renders the text portion of the message separately from the URL', () => {
      // Arrange
      const message = 'Find help at https://example.org/crisis';

      // Act
      render(<SupportNotice message={message} />);

      // Assert: the prose portion is present without the URL appended.
      expect(screen.getByText('Find help at')).toBeInTheDocument();
    });

    it('renders the URL as a clickable link with the correct href', () => {
      // Arrange
      const message = 'Reach out at https://support.example.com/help';

      // Act
      render(<SupportNotice message={message} />);

      // Assert: the link resolves to the exact URL in the message.
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', 'https://support.example.com/help');
    });

    it('opens the support link in a new tab', () => {
      // Arrange
      const message = 'Visit https://example.org/support';

      // Act
      render(<SupportNotice message={message} />);

      // Assert: target="_blank" so the questionnaire session is not navigated away.
      expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
    });

    it('applies rel="noopener noreferrer" on the support link', () => {
      // Arrange
      const message = 'Visit https://example.org/support';

      // Act
      render(<SupportNotice message={message} />);

      // Assert: security attributes present for all external links opened in a new tab.
      expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders the URL text as the link label', () => {
      // Arrange
      const url = 'https://helpline.example.org';
      const message = `Call or text us: ${url}`;

      // Act
      render(<SupportNotice message={message} />);

      // Assert: the anchor's visible label is the URL string itself (no custom label).
      expect(screen.getByRole('link')).toHaveTextContent(url);
    });

    it('handles an https URL with a path and query string', () => {
      // Arrange
      const url = 'https://example.org/chat?topic=crisis&lang=en';
      const message = `Chat now: ${url}`;

      // Act
      render(<SupportNotice message={message} />);

      // Assert: the full URL including query params is preserved in the href.
      expect(screen.getByRole('link')).toHaveAttribute('href', url);
    });

    it('does NOT include the URL in the plain text paragraph', () => {
      // Arrange
      const url = 'https://example.org/support';
      const message = `Get help at ${url}`;

      // Act
      render(<SupportNotice message={message} />);

      // Assert: the text node before the link contains only the prose, not the URL.
      // getByText with exact=false would match the combined paragraph — use queryByText
      // with the URL string to confirm it does not appear as plain text.
      expect(screen.queryByText(url, { selector: 'p' })).toBeNull();
    });
  });

  describe('LifeBuoy icon', () => {
    it('renders an element marked aria-hidden to exclude the icon from the a11y tree', () => {
      // Arrange / Act
      render(<SupportNotice message="Support is here for you." />);

      // Assert: the SVG icon carries aria-hidden="true" so screen readers skip it.
      const svgs = document.querySelectorAll('svg[aria-hidden="true"]');
      expect(svgs.length).toBeGreaterThan(0);
    });
  });

  describe('optional className', () => {
    it('forwards a custom className to the outer container', () => {
      // Arrange / Act
      render(<SupportNotice message="Any message." className="mt-4" />);

      // Assert: caller-supplied spacing/layout class is applied to the wrapper.
      expect(screen.getByRole('status')).toHaveClass('mt-4');
    });

    it('renders without error when className is omitted', () => {
      // Arrange / Act / Assert: no className → no crash and container still exists.
      render(<SupportNotice message="Any message." />);
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });
});
