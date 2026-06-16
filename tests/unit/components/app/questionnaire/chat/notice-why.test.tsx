/**
 * NoticeWhy Tests
 *
 * Covers: null/empty detail renders nothing, "Why?" toggle button renders when
 * detail is present, aria-expanded reflects open state, detail paragraph is
 * shown/hidden on successive clicks, whitespace-only detail is treated as absent,
 * and the optional className is forwarded to the outer div.
 *
 * @see components/app/questionnaire/chat/notice-why.tsx
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NoticeWhy } from '@/components/app/questionnaire/chat/notice-why';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NoticeWhy', () => {
  describe('renders nothing when there is no usable detail', () => {
    it('returns null when detail is undefined', () => {
      // Arrange / Act
      const { container } = render(<NoticeWhy />);

      // Assert: no DOM output — the component explicitly returns null.
      expect(container).toBeEmptyDOMElement();
    });

    it('returns null when detail is an empty string', () => {
      const { container } = render(<NoticeWhy detail="" />);
      expect(container).toBeEmptyDOMElement();
    });

    it('returns null when detail is whitespace only', () => {
      // The component calls detail.trim().length === 0 to gate rendering.
      const { container } = render(<NoticeWhy detail="   " />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('toggle button', () => {
    it('renders a "Why?" button when a non-empty detail is provided', () => {
      render(<NoticeWhy detail="The agent detected a contradiction." />);

      // Assert: the component renders something the respondent can interact with.
      expect(screen.getByRole('button', { name: /why\?/i })).toBeInTheDocument();
    });

    it('button has type="button" to avoid accidental form submission', () => {
      render(<NoticeWhy detail="Rationale text." />);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    });

    it('detail paragraph is hidden before the button is clicked', () => {
      render(<NoticeWhy detail="Hidden rationale." />);

      // The paragraph is only rendered when open=true (conditional render, not visibility).
      expect(screen.queryByText('Hidden rationale.')).not.toBeInTheDocument();
    });
  });

  describe('aria-expanded reflects open state', () => {
    it('starts with aria-expanded="false"', () => {
      render(<NoticeWhy detail="Reason." />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    });

    it('sets aria-expanded="true" after the first click', async () => {
      const user = userEvent.setup();
      render(<NoticeWhy detail="Reason." />);

      await user.click(screen.getByRole('button'));

      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    });

    it('sets aria-expanded back to "false" after a second click', async () => {
      const user = userEvent.setup();
      render(<NoticeWhy detail="Reason." />);

      await user.click(screen.getByRole('button'));
      await user.click(screen.getByRole('button'));

      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('detail paragraph visibility', () => {
    it('reveals the detail text on the first click', async () => {
      const user = userEvent.setup();
      const detail = 'The seriousness judge scored this response below the threshold.';
      render(<NoticeWhy detail={detail} />);

      await user.click(screen.getByRole('button'));

      // Assert: the detail the component was given is now in the DOM — not just a mock return.
      expect(screen.getByText(detail)).toBeInTheDocument();
    });

    it('hides the detail text again on the second click', async () => {
      const user = userEvent.setup();
      const detail = 'Toggle me away.';
      render(<NoticeWhy detail={detail} />);

      await user.click(screen.getByRole('button'));
      expect(screen.getByText(detail)).toBeInTheDocument();

      await user.click(screen.getByRole('button'));
      expect(screen.queryByText(detail)).not.toBeInTheDocument();
    });
  });

  describe('optional className', () => {
    it('forwards className to the outer div when provided', () => {
      render(<NoticeWhy detail="Some detail." className="custom-spacing" />);

      // The outer div wraps the button; find via the button's parent.
      const button = screen.getByRole('button');
      expect(button.closest('div')).toHaveClass('custom-spacing');
    });

    it('renders without error when className is omitted', () => {
      render(<NoticeWhy detail="Some detail." />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });

  describe('ChevronDown icon', () => {
    it('marks the icon aria-hidden to exclude it from the accessibility tree', () => {
      render(<NoticeWhy detail="Some detail." />);

      const hiddenSvgs = document.querySelectorAll('svg[aria-hidden="true"]');
      expect(hiddenSvgs.length).toBeGreaterThan(0);
    });
  });
});
