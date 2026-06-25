/**
 * ChatErrorPanel — blocking / error state panels for the respondent chat surface (F7.1).
 *
 * Covers: terminal statuses (cost_capped / not_active / expired) render a role="status"
 * container; only `expired` includes a "Reload" button; transient `error` renders a
 * role="alert" banner; the dismiss button appears only for the transient error when
 * `onDismiss` is provided; clicking dismiss calls the callback.
 *
 * @see components/app/questionnaire/chat/chat-error-panel.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatErrorPanel } from '@/components/app/questionnaire/chat/chat-error-panel';
import type { QuestionnaireChatStatus, ChatErrorState } from '@/lib/app/questionnaire/chat/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeError(overrides: Partial<ChatErrorState> = {}): ChatErrorState {
  return {
    code: 'TEST_CODE',
    title: 'Something happened',
    message: 'Here is more detail about what happened.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Terminal statuses — role="status"
// ---------------------------------------------------------------------------

describe('ChatErrorPanel — terminal statuses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const terminalCases: QuestionnaireChatStatus[] = ['cost_capped', 'not_active', 'expired'];

  for (const status of terminalCases) {
    describe(`status="${status}"`, () => {
      it('renders a role="status" container (not role="alert")', () => {
        // Arrange
        const error = makeError();

        // Act
        render(<ChatErrorPanel status={status} error={error} />);

        // Assert: terminal panels use polite status, not alert (no screen-reader interrupt).
        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
      });

      it('renders the error title', () => {
        // Arrange
        const error = makeError({ title: `Title for ${status}` });

        // Act
        render(<ChatErrorPanel status={status} error={error} />);

        // Assert: title text is visible inside the panel.
        expect(screen.getByText(`Title for ${status}`)).toBeInTheDocument();
      });

      it('renders the error message', () => {
        // Arrange
        const error = makeError({ message: `Message for ${status}` });

        // Act
        render(<ChatErrorPanel status={status} error={error} />);

        // Assert: body copy is visible inside the panel.
        expect(screen.getByText(`Message for ${status}`)).toBeInTheDocument();
      });

      it('does NOT show a Dismiss button even when onDismiss is provided', () => {
        // Arrange: terminal panels must never show the dismiss button — it would let
        // the respondent dismiss a blocking state and be left with no error indication.
        const error = makeError();
        const onDismiss = vi.fn();

        // Act
        render(<ChatErrorPanel status={status} error={error} onDismiss={onDismiss} />);

        // Assert: no dismiss affordance exists in the terminal panel.
        expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Reload button — expired only
  // -------------------------------------------------------------------------

  describe('"Reload" button', () => {
    it('renders a "Reload" button only for the expired status', () => {
      // Arrange
      const error = makeError();

      // Act
      render(<ChatErrorPanel status="expired" error={error} />);

      // Assert: the Reload button exists for the expired status.
      expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    });

    it('does NOT render a "Reload" button for cost_capped', () => {
      // Arrange
      const error = makeError();

      // Act
      render(<ChatErrorPanel status="cost_capped" error={error} />);

      // Assert: the Reload affordance is absent — the session is over, not just expired.
      expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    });

    it('does NOT render a "Reload" button for not_active', () => {
      // Arrange
      const error = makeError();

      // Act
      render(<ChatErrorPanel status="not_active" error={error} />);

      // Assert
      expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    });

    it('triggers a page reload when the "Reload" button is clicked', async () => {
      // Arrange: stub reload so the test environment doesn't perform a real navigation.
      // Use vi.stubGlobal (not Object.defineProperty) so afterEach's unstubAllGlobals restores
      // the real window.location — otherwise the stubbed reload leaks into later tests.
      const reloadSpy = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload: reloadSpy });
      const error = makeError();
      const user = userEvent.setup();

      // Act
      render(<ChatErrorPanel status="expired" error={error} />);
      await user.click(screen.getByRole('button', { name: /reload/i }));

      // Assert: the click handler invokes window.location.reload exactly once.
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Transient error status — role="alert"
// ---------------------------------------------------------------------------

describe('ChatErrorPanel — transient error status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a role="alert" container (not role="status")', () => {
    // Arrange
    const error = makeError();

    // Act
    render(<ChatErrorPanel status="error" error={error} />);

    // Assert: transient errors use alert so screen readers interrupt immediately.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the error title inside the alert', () => {
    // Arrange
    const error = makeError({ title: 'Rate limit hit' });

    // Act
    render(<ChatErrorPanel status="error" error={error} />);

    // Assert
    expect(screen.getByText('Rate limit hit')).toBeInTheDocument();
  });

  it('renders the error message inside the alert', () => {
    // Arrange
    const error = makeError({ message: 'Please try again in a moment.' });

    // Act
    render(<ChatErrorPanel status="error" error={error} />);

    // Assert
    expect(screen.getByText('Please try again in a moment.')).toBeInTheDocument();
  });

  it('does NOT render a Dismiss button when onDismiss is not provided', () => {
    // Arrange: no dismiss callback → the button must be absent (no orphaned X icon).
    const error = makeError();

    // Act
    render(<ChatErrorPanel status="error" error={error} />);

    // Assert
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('renders a Dismiss button when onDismiss is provided', () => {
    // Arrange
    const error = makeError();
    const onDismiss = vi.fn();

    // Act
    render(<ChatErrorPanel status="error" error={error} onDismiss={onDismiss} />);

    // Assert: the dismiss affordance is present so the respondent can retry.
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('calls onDismiss when the Dismiss button is clicked', async () => {
    // Arrange
    const error = makeError();
    const onDismiss = vi.fn();
    const user = userEvent.setup();

    // Act
    render(<ChatErrorPanel status="error" error={error} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    // Assert: exactly one call — not zero, not multiple on a single click.
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT render a "Reload" button in the transient error state', () => {
    // Arrange: the Reload affordance belongs only to the `expired` terminal state.
    const error = makeError();

    // Act
    render(<ChatErrorPanel status="error" error={error} />);

    // Assert
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });

  it('does NOT render a "Try again" button when onRetry is not provided', () => {
    // Arrange: no retry callback → no button (the failure isn't recoverable via this surface).
    const error = makeError();

    // Act
    render(<ChatErrorPanel status="error" error={error} />);

    // Assert
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('renders a "Try again" button when onRetry is provided', () => {
    // Arrange
    const error = makeError();
    const onRetry = vi.fn();

    // Act
    render(<ChatErrorPanel status="error" error={error} onRetry={onRetry} />);

    // Assert: the retry affordance is present so the respondent can resend without retyping.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('calls onRetry when the "Try again" button is clicked', async () => {
    // Arrange
    const error = makeError();
    const onRetry = vi.fn();
    const user = userEvent.setup();

    // Act
    render(<ChatErrorPanel status="error" error={error} onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    // Assert: exactly one resend per click.
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Terminal statuses never offer retry (a re-send would just re-fail)
// ---------------------------------------------------------------------------

describe('ChatErrorPanel — terminal statuses never retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const terminalCases: QuestionnaireChatStatus[] = ['cost_capped', 'not_active', 'expired'];

  for (const status of terminalCases) {
    it(`does NOT show a "Try again" button for status="${status}" even when onRetry is provided`, () => {
      // Arrange
      const error = makeError();
      const onRetry = vi.fn();

      // Act
      render(<ChatErrorPanel status={status} error={error} onRetry={onRetry} />);

      // Assert: terminal panels are non-recoverable — no retry affordance.
      expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    });
  }
});
