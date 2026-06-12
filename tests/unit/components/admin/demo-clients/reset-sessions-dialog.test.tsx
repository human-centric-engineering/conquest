/**
 * ResetSessionsDialog component tests.
 *
 * The dialog gates the destructive "Reset sessions" action behind a typed-slug
 * confirmation. Key behaviours:
 *  - confirm button is disabled until the typed slug matches the `slug` prop
 *  - a successful POST shows deleted counts and calls router.refresh() on close
 *  - ANONYMOUS_MODE_PROTECTED and CONFIRM_SLUG_MISMATCH error codes render
 *    specific inline messages
 *  - ?resetInvitations=true is appended to the URL when the checkbox is checked
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mock next/navigation ─────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRouterRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// ─── Mock API client ──────────────────────────────────────────────────────────

// Use vi.hoisted so the class and mock fn exist before the vi.mock factory runs.
const { mockApiPost, MockAPIClientError } = vi.hoisted(() => {
  // APIClientError needs to be a real class so `instanceof` checks in the source work.
  class HoistedAPIClientError extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
    }
  }
  return {
    mockApiPost: vi.fn(),
    MockAPIClientError: HoistedAPIClientError,
  };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: mockApiPost },
  APIClientError: MockAPIClientError,
}));

// ─── Component import ─────────────────────────────────────────────────────────

import { ResetSessionsDialog } from '@/components/admin/demo-clients/reset-sessions-dialog';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  id: 'dc-1',
  name: 'Acme Corp',
  slug: 'acme-corp',
};

function makeDeletedCounts() {
  return { sessions: 3, answerSlots: 12, turns: 24, events: 50, invitations: 2 };
}

/** Open the dialog and return user. */
async function openDialog(props = DEFAULT_PROPS) {
  const user = userEvent.setup();
  render(<ResetSessionsDialog {...props} />);
  await user.click(screen.getByRole('button', { name: /reset sessions/i }));
  // Wait for dialog content to appear
  await screen.findByRole('dialog');
  return user;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ResetSessionsDialog', () => {
  describe('confirm button disabled state', () => {
    it('confirm button is disabled when the slug input is empty', async () => {
      await openDialog();
      // Find the "Reset sessions" button inside the dialog footer (not the trigger)
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      const confirmButton = buttons[buttons.length - 1];
      expect(confirmButton).toBeDisabled();
    });

    it('confirm button is disabled when the typed slug does not match', async () => {
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'wrong-slug');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      const confirmButton = buttons[buttons.length - 1];
      expect(confirmButton).toBeDisabled();
    });

    it('confirm button is enabled when the typed slug exactly matches', async () => {
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      const confirmButton = buttons[buttons.length - 1];
      expect(confirmButton).not.toBeDisabled();
    });
  });

  describe('successful reset', () => {
    it('shows deleted session count on success', async () => {
      mockApiPost.mockResolvedValue({
        id: 'dc-1',
        deletedCounts: makeDeletedCounts(),
        resetInvitations: false,
      });
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText('Sessions reset')).toBeInTheDocument();
      });
      expect(screen.getByText('3 sessions')).toBeInTheDocument();
      expect(screen.getByText('12 answers')).toBeInTheDocument();
      expect(screen.getByText('24 turns')).toBeInTheDocument();
    });

    it('calls router.refresh() when the success dialog is closed', async () => {
      mockApiPost.mockResolvedValue({
        id: 'dc-1',
        deletedCounts: makeDeletedCounts(),
        resetInvitations: false,
      });
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => screen.getByText('Sessions reset'));
      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
      });
    });

    it('shows invitation count when resetInvitations is true in the response', async () => {
      mockApiPost.mockResolvedValue({
        id: 'dc-1',
        deletedCounts: makeDeletedCounts(),
        resetInvitations: true,
      });
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => screen.getByText('Sessions reset'));
      expect(screen.getByText('2 invitations')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('shows the anonymous-mode-protected inline message for ANONYMOUS_MODE_PROTECTED error', async () => {
      mockApiPost.mockRejectedValue(
        new MockAPIClientError('protected', 'ANONYMOUS_MODE_PROTECTED', 409)
      );
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => {
        expect(
          screen.getByText(/anonymous mode — its research data is protected/i)
        ).toBeInTheDocument();
      });
    });

    it('shows the slug-mismatch inline message for CONFIRM_SLUG_MISMATCH error', async () => {
      mockApiPost.mockRejectedValue(
        new MockAPIClientError('mismatch', 'CONFIRM_SLUG_MISMATCH', 400)
      );
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      // The source uses a curly apostrophe (’) in "didn’t"
      await waitFor(() => {
        expect(screen.getByText(/confirmation.*match the client slug/i)).toBeInTheDocument();
      });
    });

    it('shows the error message for any other APIClientError', async () => {
      mockApiPost.mockRejectedValue(
        new MockAPIClientError('Something went wrong', 'INTERNAL_ERROR', 500)
      );
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      });
    });

    it('shows a fallback message for a non-APIClientError', async () => {
      mockApiPost.mockRejectedValue(new Error('network failure'));
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText('Could not reset sessions.')).toBeInTheDocument();
      });
    });
  });

  describe('?resetInvitations=true query param', () => {
    it('does NOT include ?resetInvitations=true when the checkbox is unchecked', async () => {
      mockApiPost.mockResolvedValue({
        id: 'dc-1',
        deletedCounts: makeDeletedCounts(),
        resetInvitations: false,
      });
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(1));
      // The URL passed to apiClient.post should NOT include ?resetInvitations=true
      const calledUrl: string = mockApiPost.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('resetInvitations');
    });

    it('appends ?resetInvitations=true to the URL when the checkbox is checked', async () => {
      mockApiPost.mockResolvedValue({
        id: 'dc-1',
        deletedCounts: makeDeletedCounts(),
        resetInvitations: true,
      });
      const user = await openDialog();
      // Check the "Also clear stale invitations" checkbox
      await user.click(screen.getByLabelText(/also clear stale invitations/i));
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(1));
      const calledUrl: string = mockApiPost.mock.calls[0][0] as string;
      expect(calledUrl).toContain('?resetInvitations=true');
    });

    it('sends the typed slug as the POST body confirmSlug field', async () => {
      mockApiPost.mockResolvedValue({
        id: 'dc-1',
        deletedCounts: makeDeletedCounts(),
        resetInvitations: false,
      });
      const user = await openDialog();
      await user.type(screen.getByLabelText(/type the client slug/i), 'acme-corp');
      const buttons = screen.getAllByRole('button', { name: /reset sessions/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(1));
      const calledOptions = mockApiPost.mock.calls[0][1] as { body: { confirmSlug: string } };
      // The route sends the typed slug — assert the client forwarded the value correctly
      expect(calledOptions.body.confirmSlug).toBe('acme-corp');
    });
  });
});
