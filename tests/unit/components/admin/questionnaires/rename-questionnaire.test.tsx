/**
 * RenameQuestionnaire component tests.
 *
 * Anti-green-bar: drives the form the way an admin does — types a new name, clicks
 * Save — and asserts the real outcomes: the PATCH body sent, the disabled/enabled
 * state of the Save button, the trim, and the inline error on failure. The network
 * client and the router are the only mocked seams.
 *
 * @see components/admin/questionnaires/rename-questionnaire.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {
    code: string;
    constructor(message: string, code = 'ERROR') {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { RenameQuestionnaire } from '@/components/admin/questionnaires/rename-questionnaire';

const QN_ID = 'qn-1';
const CURRENT = 'Chris Thomas Questionnaire.xlsx';

function renderForm() {
  return render(<RenameQuestionnaire questionnaireId={QN_ID} currentTitle={CURRENT} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RenameQuestionnaire', () => {
  it('starts with the current title and Save disabled (unchanged)', () => {
    renderForm();
    expect(screen.getByRole('textbox')).toHaveValue(CURRENT);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('keeps Save disabled when the field is emptied', async () => {
    const user = userEvent.setup();
    renderForm();
    const input = screen.getByRole('textbox');
    await user.clear(input);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('PATCHes the trimmed title and refreshes on success', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ id: QN_ID, title: 'Merlin5 Questionnaire' });
    const user = userEvent.setup();
    renderForm();

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, '  Merlin5 Questionnaire  ');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(`/api/v1/app/questionnaires/${QN_ID}`, {
        body: { title: 'Merlin5 Questionnaire' },
      });
    });
    expect(mockRefresh).toHaveBeenCalledOnce();
    // The field normalises to the trimmed, saved value (router.refresh then re-feeds
    // the matching currentTitle prop from the server in the real app).
    expect(screen.getByRole('textbox')).toHaveValue('Merlin5 Questionnaire');
  });

  it('shows an inline error and does not refresh when the PATCH fails', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Name already in use', 'CONFLICT')
    );
    const user = userEvent.setup();
    renderForm();

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Merlin5 Questionnaire');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Name already in use')).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
