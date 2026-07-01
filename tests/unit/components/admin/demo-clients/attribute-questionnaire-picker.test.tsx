/**
 * AttributeQuestionnairePicker tests.
 *
 * The reverse-attribution control on a demo client's detail page: pick a generic questionnaire and
 * brand it as this client via `PATCH /api/v1/app/questionnaires/:id { demoClientId }`, then refresh.
 * Behaviours:
 *  - empty options → a hint, no combobox/button
 *  - with options → the Attribute button is disabled until a questionnaire is chosen
 *  - choosing one and clicking Attribute PATCHes { demoClientId: clientId } for that questionnaire, refreshes
 *  - a failed PATCH renders an inline error and does not refresh
 *
 * @see components/admin/demo-clients/attribute-questionnaire-picker.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRouterRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ refresh: mockRouterRefresh, push: vi.fn(), replace: vi.fn() })),
}));

const { mockApiPatch, MockAPIClientError } = vi.hoisted(() => {
  class HoistedAPIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  }
  return { mockApiPatch: vi.fn(), MockAPIClientError: HoistedAPIClientError };
});
vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: mockApiPatch },
  APIClientError: MockAPIClientError,
}));

import { AttributeQuestionnairePicker } from '@/components/admin/demo-clients/attribute-questionnaire-picker';
import type { AttributedQuestionnaireRow } from '@/lib/app/questionnaire/demo-clients';

const OPTIONS: AttributedQuestionnaireRow[] = [
  { id: 'q1', title: 'Onboarding survey', status: 'draft' },
  { id: 'q2', title: 'Exit interview', status: 'launched' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApiPatch.mockResolvedValue({});
});

describe('AttributeQuestionnairePicker', () => {
  it('shows a hint and no control when there is nothing to attribute', () => {
    render(<AttributeQuestionnairePicker clientId="c1" options={[]} />);
    expect(screen.getByText(/No unattributed questionnaires are available/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /attribute/i })).not.toBeInTheDocument();
  });

  it('disables the Attribute button until a questionnaire is chosen', () => {
    render(<AttributeQuestionnairePicker clientId="c1" options={OPTIONS} />);
    expect(screen.getByRole('button', { name: /attribute/i })).toBeDisabled();
  });

  it('attributes the chosen questionnaire to this client and refreshes', async () => {
    const user = userEvent.setup();
    render(<AttributeQuestionnairePicker clientId="client-7" options={OPTIONS} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Exit interview' }));
    await user.click(screen.getByRole('button', { name: /attribute/i }));

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/app/questionnaires/q2', {
        body: { demoClientId: 'client-7' },
      })
    );
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('renders an inline error and does not refresh when the PATCH fails', async () => {
    mockApiPatch.mockRejectedValue(new MockAPIClientError('Nope', 'CONFLICT'));
    const user = userEvent.setup();
    render(<AttributeQuestionnairePicker clientId="client-7" options={OPTIONS} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Onboarding survey' }));
    await user.click(screen.getByRole('button', { name: /attribute/i }));

    await waitFor(() => expect(screen.getByText('Nope')).toBeInTheDocument());
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });
});
