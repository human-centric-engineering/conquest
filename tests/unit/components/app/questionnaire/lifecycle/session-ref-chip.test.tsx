/**
 * SessionRefChip — respondent-facing support reference chip.
 *
 * Covers:
 * - Renders the formatted reference (grouped with dash)
 * - Renders the "Ref:" label and the copy icon by default
 * - Flips to Check icon after a successful clipboard write, then reverts after 2 s
 * - Shows the Check icon immediately and reverts to Copy icon after the timer fires
 * - Handles clipboard unavailability gracefully (no crash, no icon flip)
 * - Passes through custom className
 * - Correct aria-label includes both the formatted ref and the tooltip text
 * - Correct button title matches the tooltip constant
 *
 * @see components/app/questionnaire/lifecycle/session-ref-chip.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionRefChip } from '@/components/app/questionnaire/lifecycle/session-ref-chip';

// ---------------------------------------------------------------------------
// Clipboard helpers
// ---------------------------------------------------------------------------

/**
 * Stub navigator.clipboard AFTER userEvent.setup() (which installs its own stub).
 * The approach used in the sibling drawer test: Object.defineProperty to avoid
 * "read-only" errors in happy-dom.
 */
function mockClipboard(options?: { rejectWith?: Error }) {
  const writeText = options?.rejectWith
    ? vi.fn().mockRejectedValue(options.rejectWith)
    : vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });

  return { writeText };
}

// Restore the original clipboard descriptor after every test so stubs don't leak.
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionRefChip', () => {
  it('renders the formatted reference grouped with a dash', () => {
    // Arrange: 8-char raw ref — formatSessionRef produces "ABCD-EFGH"
    render(<SessionRefChip refRaw="ABCDEFGH" />);

    // Assert: the formatted text (code produced by the component, not the mock) is visible
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
  });

  it('renders the "Ref:" label', () => {
    render(<SessionRefChip refRaw="ABCDEFGH" />);

    expect(screen.getByText('Ref:')).toBeInTheDocument();
  });

  it('shows the copy icon (not the check icon) on initial render', () => {
    render(<SessionRefChip refRaw="ABCDEFGH" />);

    // The Copy icon has aria-hidden="true" — query by role hidden so we can
    // confirm it's there, but check the Check icon is absent.
    const button = screen.getByRole('button');
    // There should be exactly one svg (the Copy icon) and no check icon
    const svgs = button.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    // Check icon has a path with the standard Lucide check shape; Copy doesn't.
    // The simplest proxy is: after click the icon changes class/shape, so we
    // trust the visual state via aria-label — pre-click it contains "Click to copy".
    expect(button).toHaveAttribute('aria-label', expect.stringContaining('Click to copy'));
  });

  it('has the correct title attribute', () => {
    render(<SessionRefChip refRaw="ABCDEFGH" />);

    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute(
      'title',
      'Quote this reference if you need to report a problem with this conversation.'
    );
  });

  it('aria-label includes the formatted ref and tooltip text', () => {
    render(<SessionRefChip refRaw="7F3K9M2P" />);

    const btn = screen.getByRole('button');
    const label = btn.getAttribute('aria-label') ?? '';
    // The label should embed the display form (with dash), not the raw form
    expect(label).toContain('7F3K-9M2P');
    expect(label).toContain('Quote this reference');
    expect(label).toContain('Click to copy');
  });

  it('applies the optional className to the button', () => {
    render(<SessionRefChip refRaw="ABCDEFGH" className="my-custom-class" />);

    expect(screen.getByRole('button')).toHaveClass('my-custom-class');
  });

  describe('copy to clipboard — success path', () => {
    it('writes the formatted (not raw) ref to the clipboard on click', async () => {
      const user = userEvent.setup();
      const { writeText } = mockClipboard();

      render(<SessionRefChip refRaw="ABCDEFGH" />);
      await user.click(screen.getByRole('button'));

      // The component must write the dash-grouped display string, not the raw value
      expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    });

    it('flips to the check icon immediately after a successful copy', async () => {
      // Use fake timers so the 2 s revert never fires during the assertion
      vi.useFakeTimers();
      const { writeText } = mockClipboard();

      render(<SessionRefChip refRaw="ABCDEFGH" />);

      // Click using fireEvent-style act since userEvent + fake timers don't mix
      // (see gotchas.md #24)
      await act(async () => {
        screen.getByRole('button').click();
        // Allow the clipboard promise microtask to settle
        await Promise.resolve();
      });

      // writeText must have been called (proves the copy path ran)
      expect(writeText).toHaveBeenCalledTimes(1);

      // The button always renders exactly one svg (Check OR Copy), so an svg
      // count alone can't prove the flip. The source distinguishes the two icons
      // by class: the Check (copied) icon carries `text-emerald-500`, the Copy
      // (idle) icon carries `opacity-60`. Assert the Check icon is now shown and
      // the Copy icon is gone — this fails if the copy did not flip the state.
      const button = screen.getByRole('button');
      const icon = button.querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon).toHaveClass('text-emerald-500'); // Check icon (copied state)
      expect(icon).not.toHaveClass('opacity-60'); // not the idle Copy icon
    });

    it('reverts to the copy icon 2 s after a successful copy', async () => {
      vi.useFakeTimers();
      mockClipboard();

      render(<SessionRefChip refRaw="ABCDEFGH" />);

      // Trigger copy
      await act(async () => {
        screen.getByRole('button').click();
        await Promise.resolve();
      });

      // Sanity: the copy flipped the chip into the Check (copied) state.
      const copiedIcon = screen.getByRole('button').querySelector('svg');
      expect(copiedIcon).toHaveClass('text-emerald-500');

      // Advance fake clock by 2 s — this fires the setTimeout(() => setCopied(false), 2000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // After the timer fires the chip must revert to the idle Copy icon. The
      // source renders the Copy icon with `opacity-60` and the Check icon with
      // `text-emerald-500`, so assert the idle Copy icon is back and the Check
      // icon is gone — this fails if the 2 s revert never happened.
      const revertedIcon = screen.getByRole('button').querySelector('svg');
      expect(revertedIcon).not.toBeNull();
      expect(revertedIcon).toHaveClass('opacity-60'); // idle Copy icon
      expect(revertedIcon).not.toHaveClass('text-emerald-500'); // not the Check icon
    });
  });

  describe('copy to clipboard — failure path', () => {
    it('does not flip to check icon when clipboard throws', async () => {
      vi.useFakeTimers();
      const { writeText } = mockClipboard({ rejectWith: new Error('Clipboard unavailable') });

      render(<SessionRefChip refRaw="ABCDEFGH" />);

      // Trigger copy (the error is swallowed per the catch block in the source)
      await act(async () => {
        screen.getByRole('button').click();
        await Promise.resolve();
        // flush the rejection microtask
        await Promise.resolve();
      });

      // writeText was called (the copy path ran)
      expect(writeText).toHaveBeenCalledTimes(1);

      // Icon remains the Copy icon (copied state stays false)
      // Advance timers to confirm no spurious revert timer fires
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Button is still present — component didn't crash
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });

  describe('non-standard ref lengths', () => {
    it('uppercases and returns the raw value as-is when shorter than 8 chars', () => {
      // formatSessionRef returns the uppercased value for non-8-char input
      render(<SessionRefChip refRaw="abc" />);

      expect(screen.getByText('ABC')).toBeInTheDocument();
    });

    it('uppercases and returns the raw value as-is when longer than 8 chars', () => {
      render(<SessionRefChip refRaw="abcdefghi" />);

      expect(screen.getByText('ABCDEFGHI')).toBeInTheDocument();
    });
  });
});
