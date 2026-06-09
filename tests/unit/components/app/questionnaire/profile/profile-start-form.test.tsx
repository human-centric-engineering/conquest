/**
 * ProfileStartForm Component Tests (F8.3)
 *
 * Tests the profile form rendered before a non-anonymous session starts.
 * The form renders one input per admin-authored ProfileFieldConfig, validates
 * with Zod, POSTs to the session-create route via apiClient, and navigates to
 * the chat on success.
 *
 * Test Coverage:
 * - Rendering: one input per field type (text/email/number/select) with labels
 * - Rendering: required vs optional field markers
 * - Rendering: select field renders all options
 * - Zod validation: submitting with empty required field shows error, no API call
 * - Zod validation: email type rejects non-email values
 * - Zod validation: number type rejects non-numeric values
 * - Happy path: valid submit calls apiClient.post with correct endpoint + payload + token
 * - Happy path: on success, router.push navigates to /questionnaires/<sessionId>
 * - API failure: APIClientError message shown, no navigation
 * - API failure: unexpected error shows fallback message, no navigation
 * - Loading state: button shows "Starting…" while submitting
 * - Loading state: button disabled while submitting
 *
 * @see components/app/questionnaire/profile/profile-start-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProfileStartForm } from '@/components/app/questionnaire/profile/profile-start-form';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
    constructor(
      message: string,
      code?: string,
      status?: number,
      details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
      this.details = details;
    }
  },
}));

// next/navigation is globally mocked in tests/setup.ts; we override useRouter
// per-describe to capture the push spy.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal set of fields covering all four types. */
const MIXED_FIELDS: ProfileFieldConfig[] = [
  { key: 'name', label: 'Full Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'age', label: 'Age', type: 'number', required: false },
  {
    key: 'role',
    label: 'Role',
    type: 'select',
    required: true,
    options: ['Engineer', 'Designer', 'Manager'],
  },
];

const INVITATION_TOKEN = 'tok_test_abc123';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('components/app/questionnaire/profile/profile-start-form', () => {
  const mockPush = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();

    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders one labelled input for each text/email/number field', () => {
      // Arrange & Act
      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />
      );

      // Assert: one input element per non-select field keyed by the id the component assigns
      // (id="profile-{key}").  We query by id because the Label wraps a FieldHelp button whose
      // aria-label also matches the label text, so getByLabelText would find multiple elements.
      expect(container.querySelector('#profile-name')).toBeInTheDocument();
      expect(container.querySelector('#profile-email')).toBeInTheDocument();
      expect(container.querySelector('#profile-age')).toBeInTheDocument();
    });

    it('renders the correct input type for email fields', () => {
      // Arrange & Act
      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />
      );

      // Assert: the email input has type="email"
      const emailInput = container.querySelector('#profile-email');
      expect(emailInput).toHaveAttribute('type', 'email');
    });

    it('renders the correct input type for number fields', () => {
      // Arrange & Act
      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />
      );

      // Assert: the number input has type="number"
      const ageInput = container.querySelector('#profile-age');
      expect(ageInput).toHaveAttribute('type', 'number');
    });

    it('renders a <select> element for select-type fields', () => {
      // Arrange & Act
      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />
      );

      // Assert: select element is present with the id the component assigns
      const select = container.querySelector('#profile-role');
      expect(select).toBeInTheDocument();
      expect(select?.tagName).toBe('SELECT');
    });

    it('renders all options for a select field plus the placeholder option', () => {
      // Arrange & Act
      render(<ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />);

      // Assert: all three admin-authored options appear in the document
      expect(screen.getByRole('option', { name: 'Engineer' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Designer' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Manager' })).toBeInTheDocument();
      // Placeholder option should also be present
      expect(screen.getByRole('option', { name: /select…/i })).toBeInTheDocument();
    });

    it('marks optional fields with "(optional)"', () => {
      // Arrange & Act
      render(<ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />);

      // Assert: the optional "age" field shows the "(optional)" span
      // (exactly one optional field in MIXED_FIELDS)
      expect(screen.getAllByText('(optional)')).toHaveLength(1);
    });

    it('does not show "(optional)" for required fields', () => {
      // Arrange — single required text field
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];

      // Act
      render(<ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />);

      // Assert: no optional marker
      expect(screen.queryByText('(optional)')).not.toBeInTheDocument();
    });

    it('renders a submit button labelled "Start questionnaire"', () => {
      // Arrange & Act
      render(<ProfileStartForm invitationToken={INVITATION_TOKEN} fields={MIXED_FIELDS} />);

      // Assert
      expect(screen.getByRole('button', { name: /start questionnaire/i })).toBeInTheDocument();
    });

    it('renders no fields when the fields array is empty', () => {
      // Arrange & Act
      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={[]} />
      );

      // Assert: form still renders with its title but no input controls
      expect(screen.getByText(/before you begin/i)).toBeInTheDocument();
      expect(container.querySelectorAll('input, select')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Zod validation
  // -------------------------------------------------------------------------

  describe('Zod validation', () => {
    it('shows a validation error and does NOT call apiClient when a required text field is empty', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');

      render(<ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />);

      // Act: submit without entering anything
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: field error is shown and the API was not called
      await waitFor(() => {
        expect(screen.getByText(/this field is required/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('shows an email validation error for a malformed email value', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'email', label: 'Email', type: 'email', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      // Query by id to avoid ambiguity from the FieldHelp button inside the Label
      const emailInput = container.querySelector('#profile-email') as HTMLInputElement;

      // Act: type an invalid email and blur (mode: onTouched)
      await user.type(emailInput, 'not-an-email');
      await user.tab();

      // Assert: validation error appears and API not called
      await waitFor(() => {
        expect(screen.getByText(/valid email/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('shows a number validation error for non-numeric input', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'age', label: 'Age', type: 'number', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const ageInput = container.querySelector('#profile-age') as HTMLInputElement;

      // Act: type non-numeric and blur
      await user.type(ageInput, 'twenty');
      await user.tab();

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/enter a number/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('shows a select validation error and does NOT call apiClient when required select is unset', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        {
          key: 'role',
          label: 'Role',
          type: 'select',
          required: true,
          options: ['Engineer', 'Designer'],
        },
      ];
      const { apiClient } = await import('@/lib/api/client');

      render(<ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />);

      // Act: submit without selecting an option
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: validation message and no API call
      await waitFor(() => {
        expect(screen.getByText(/select an option/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('successful submission', () => {
    it('calls apiClient.post with the sessions endpoint, collected values, and the invitation token', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ session: { id: 'session-abc' } });

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      // Query by id to avoid ambiguity from FieldHelp button inside Label
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;
      const emailInput = container.querySelector('#profile-email') as HTMLInputElement;

      // Act: fill fields and submit
      await user.type(nameInput, 'Jane Smith');
      await user.type(emailInput, 'jane@example.com');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: the component called the right endpoint with collected values + token
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith('/api/v1/app/questionnaire-sessions', {
          body: {
            invitationToken: INVITATION_TOKEN,
            profileValues: {
              name: 'Jane Smith',
              email: 'jane@example.com',
            },
          },
        });
      });
    });

    it('navigates to the chat URL derived from the returned session id', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ session: { id: 'sess-xyz' } });

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act
      await user.type(nameInput, 'Test User');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: router.push called with path built from the returned session id
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/questionnaires/sess-xyz');
      });
    });

    it('does NOT include empty optional field values in the payload', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
        { key: 'bio', label: 'Bio', type: 'text', required: false },
      ];
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ session: { id: 'sess-opt' } });

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act: only fill the required field; leave optional blank
      await user.type(nameInput, 'Alice');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: profileValues only contains the filled field, not the empty optional
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          '/api/v1/app/questionnaire-sessions',
          expect.objectContaining({
            body: expect.objectContaining({
              profileValues: { name: 'Alice' },
            }),
          })
        );
      });
    });

    it('includes a select field value when one is chosen', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        {
          key: 'role',
          label: 'Role',
          type: 'select',
          required: true,
          options: ['Engineer', 'Designer'],
        },
      ];
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ session: { id: 'sess-sel' } });

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const selectEl = container.querySelector('#profile-role') as HTMLSelectElement;

      // Act: choose an option and submit
      await user.selectOptions(selectEl, 'Designer');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: the selected value is sent in profileValues
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          '/api/v1/app/questionnaire-sessions',
          expect.objectContaining({
            body: expect.objectContaining({
              profileValues: { role: 'Designer' },
            }),
          })
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('loading state', () => {
    it('shows "Starting…" label and disables the button while the API call is in-flight', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');
      // Hang the API call so we can inspect the loading state
      vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act
      await user.type(nameInput, 'Loading Test');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: button transitions to submitting state
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /starting…/i });
        expect(btn).toBeDisabled();
      });
    });

    it('disables the input fields while submitting', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act
      await user.type(nameInput, 'Loading Test');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: inputs are disabled while submitting
      await waitFor(() => {
        expect(nameInput).toBeDisabled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // API failure paths
  // -------------------------------------------------------------------------

  describe('API failure handling', () => {
    it('shows the APIClientError message and does NOT navigate on APIClientError', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Session could not be created', 'SESSION_ERROR', 422)
      );

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act
      await user.type(nameInput, 'Error User');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: the component surfaces the error from APIClientError, not a fallback
      await waitFor(() => {
        expect(screen.getByText('Session could not be created')).toBeInTheDocument();
      });
      // Navigation must NOT happen on error
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('shows the fallback message and does NOT navigate for unexpected errors', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network failure'));

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act
      await user.type(nameInput, 'Error User');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: the generic fallback message is shown (not the raw error)
      await waitFor(() => {
        expect(screen.getByText(/could not start your questionnaire/i)).toBeInTheDocument();
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('re-enables the submit button after an API failure', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const fields: ProfileFieldConfig[] = [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
      ];
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Bad request', 'BAD_REQUEST'));

      const { container } = render(
        <ProfileStartForm invitationToken={INVITATION_TOKEN} fields={fields} />
      );
      const nameInput = container.querySelector('#profile-name') as HTMLInputElement;

      // Act
      await user.type(nameInput, 'Retry User');
      await user.click(screen.getByRole('button', { name: /start questionnaire/i }));

      // Assert: button is re-enabled so the respondent can retry
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start questionnaire/i })).not.toBeDisabled();
      });
    });
  });
});
