/**
 * EditableTitle — inline-editable questionnaire title for the workspace header.
 *
 * Test Coverage:
 * - View mode: title rendering and edit button
 * - useEffect: syncing value to updated title prop while not editing
 * - Edit mode: entering edit mode, input pre-fill
 * - Validation: disabled Save for empty/whitespace, error on Enter with invalid value
 * - Saving: PATCH with correct endpoint + body, router.refresh(), unchanged-title cancel
 * - Keyboard: Enter saves, Escape cancels
 * - Error handling: APIClientError message, generic fallback, stays in edit mode on failure
 *
 * @see components/admin/questionnaires/workspace/editable-title.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stable router references so assertions can track calls across renders.
const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

// apiPatch is referenced inside the factory via closure — works because the
// factory runs lazily (on first import of @/lib/api/client) after apiPatch is
// initialised. The sibling test intro-background-field.test.tsx uses the same
// pattern for apiPost.
const apiPatch = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: (...args: unknown[]) => apiPatch(...args) },
  // Declare as a real subclass so `err instanceof APIClientError` works in the
  // component — the component imports APIClientError from this same mocked module.
  APIClientError: class APIClientError extends Error {},
}));

import { EditableTitle } from '@/components/admin/questionnaires/workspace/editable-title';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Click the edit button to enter edit mode. */
async function enterEditMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /edit questionnaire name/i }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditableTitle', () => {
  describe('view mode', () => {
    it('renders the title heading text and the edit affordance button', () => {
      // Arrange & Act
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);

      // Assert: heading text is visible and the edit trigger is accessible
      expect(screen.getByText('My Survey')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit questionnaire name/i })).toBeInTheDocument();
    });

    it('pre-fills the input with the updated prop after the title prop changes while not editing', async () => {
      // Arrange: mount with initial title, then simulate an external rename
      const { rerender } = render(<EditableTitle questionnaireId="q-1" title="Old Title" />);
      rerender(<EditableTitle questionnaireId="q-1" title="New Title" />);

      // Act: enter edit mode after the prop update
      const user = userEvent.setup();
      await enterEditMode(user);

      // Assert: the input shows the updated prop value, not the stale initial one
      expect(screen.getByRole('textbox', { name: /questionnaire name/i })).toHaveValue('New Title');
    });
  });

  describe('entering edit mode', () => {
    it('clicking the edit button shows an input pre-filled with the current title', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);

      // Act
      await enterEditMode(user);

      // Assert: the textbox has the current title as its value
      expect(screen.getByRole('textbox', { name: /questionnaire name/i })).toHaveValue('My Survey');
    });

    it('shows Save and Cancel buttons in edit mode', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);

      // Act
      await enterEditMode(user);

      // Assert
      expect(screen.getByRole('button', { name: /save name/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel rename/i })).toBeInTheDocument();
    });
  });

  describe('validation', () => {
    it('disables the Save button when the input is empty', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act: clear the field — questionnaireTitleSchema requires min(1) after trim
      await user.clear(input);

      // Assert
      expect(screen.getByRole('button', { name: /save name/i })).toBeDisabled();
    });

    it('disables the Save button when the input contains only whitespace', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act: whitespace trims to empty — fails min(1) in questionnaireTitleSchema
      await user.clear(input);
      await user.type(input, '   ');

      // Assert
      expect(screen.getByRole('button', { name: /save name/i })).toBeDisabled();
    });

    it('shows the schema validation error when Enter is pressed with an empty name', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act: clear then press Enter (bypasses the disabled Save button)
      await user.clear(input);
      await user.keyboard('{Enter}');

      // Assert: error text appears; no PATCH was attempted
      await waitFor(() => {
        expect(screen.getByText(/name is required/i)).toBeInTheDocument();
      });
      expect(apiPatch).not.toHaveBeenCalled();
    });

    it('clears a visible validation error as soon as the user types again', async () => {
      // Arrange: produce the validation error first.
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="My Survey" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });
      await user.clear(input);
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.getByText(/name is required/i)).toBeInTheDocument();
      });

      // Act: typing a character fires the onChange error-clearing branch.
      await user.type(input, 'R');

      // Assert: the error is gone.
      expect(screen.queryByText(/name is required/i)).not.toBeInTheDocument();
    });
  });

  describe('saving a changed title', () => {
    it('calls apiClient.patch with the correct endpoint and body', async () => {
      // Arrange
      const user = userEvent.setup();
      apiPatch.mockResolvedValue(undefined);
      render(<EditableTitle questionnaireId="q-abc" title="Old Name" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act: change the title and click Save
      await user.clear(input);
      await user.type(input, 'New Name');
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: PATCH sent to the questionnaire's own endpoint with the new title
      await waitFor(() => {
        expect(apiPatch).toHaveBeenCalledWith('/api/v1/app/questionnaires/q-abc', {
          body: { title: 'New Name' },
        });
      });
    });

    it('calls router.refresh() after a successful PATCH', async () => {
      // Arrange
      const user = userEvent.setup();
      apiPatch.mockResolvedValue(undefined);
      render(<EditableTitle questionnaireId="q-abc" title="Old Name" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'New Name');
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: page data is refreshed so breadcrumb and list pick up the new name
      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
    });

    it('exits edit mode and shows the view heading after a successful save', async () => {
      // Arrange
      const user = userEvent.setup();
      apiPatch.mockResolvedValue(undefined);
      render(<EditableTitle questionnaireId="q-abc" title="Old Name" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'New Name');
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: input is gone; the edit button is visible again
      await waitFor(() => {
        expect(
          screen.queryByRole('textbox', { name: /questionnaire name/i })
        ).not.toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /edit questionnaire name/i })).toBeInTheDocument();
    });

    it('cancels without a PATCH call when the title is unchanged', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-abc" title="Same Title" />);
      await enterEditMode(user);

      // Act: click Save without changing the value
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: no network call; returned to view mode
      expect(apiPatch).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /edit questionnaire name/i })).toBeInTheDocument();
    });
  });

  describe('keyboard interactions', () => {
    it('pressing Enter in the input saves the new title', async () => {
      // Arrange
      const user = userEvent.setup();
      apiPatch.mockResolvedValue(undefined);
      render(<EditableTitle questionnaireId="q-1" title="Old" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'New');
      await user.keyboard('{Enter}');

      // Assert: PATCH was issued with the keyboard-submitted title
      await waitFor(() => {
        expect(apiPatch).toHaveBeenCalledWith('/api/v1/app/questionnaires/q-1', {
          body: { title: 'New' },
        });
      });
    });

    it('pressing Escape cancels — reverts the value and exits edit mode without a PATCH', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="Original" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act: start typing then hit Escape
      await user.clear(input);
      await user.type(input, 'Discarded Change');
      await user.keyboard('{Escape}');

      // Assert: no PATCH, back in view mode with the original title visible
      expect(apiPatch).not.toHaveBeenCalled();
      expect(screen.getByText('Original')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit questionnaire name/i })).toBeInTheDocument();
    });

    it('clicking the Cancel button reverts the value and exits edit mode', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EditableTitle questionnaireId="q-1" title="Original" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'Changed');
      await user.click(screen.getByRole('button', { name: /cancel rename/i }));

      // Assert
      expect(apiPatch).not.toHaveBeenCalled();
      expect(screen.getByText('Original')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit questionnaire name/i })).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('surfaces the APIClientError message when the PATCH fails', async () => {
      // Arrange: throw an APIClientError so the component renders err.message
      const { APIClientError } = await import('@/lib/api/client');
      const user = userEvent.setup();
      apiPatch.mockRejectedValue(new APIClientError('Name already taken'));
      render(<EditableTitle questionnaireId="q-1" title="Old" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'Changed');
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: the specific API error message is rendered
      await waitFor(() => {
        expect(screen.getByText('Name already taken')).toBeInTheDocument();
      });
      // No refresh should happen on failure
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('shows the generic fallback message for non-APIClientError failures', async () => {
      // Arrange: throw a plain Error (e.g. network failure)
      const user = userEvent.setup();
      apiPatch.mockRejectedValue(new Error('Network failure'));
      render(<EditableTitle questionnaireId="q-1" title="Old" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'Changed');
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: generic message rather than the raw error message
      await waitFor(() => {
        expect(screen.getByText('Could not rename the questionnaire.')).toBeInTheDocument();
      });
    });

    it('remains in edit mode after a failed PATCH so the user can retry', async () => {
      // Arrange
      const { APIClientError } = await import('@/lib/api/client');
      const user = userEvent.setup();
      apiPatch.mockRejectedValue(new APIClientError('Server error'));
      render(<EditableTitle questionnaireId="q-1" title="Old" />);
      await enterEditMode(user);
      const input = screen.getByRole('textbox', { name: /questionnaire name/i });

      // Act
      await user.clear(input);
      await user.type(input, 'Changed');
      await user.click(screen.getByRole('button', { name: /save name/i }));

      // Assert: still in edit mode (input visible, not reverted to view)
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /questionnaire name/i })).toBeInTheDocument();
      });
    });
  });
});
