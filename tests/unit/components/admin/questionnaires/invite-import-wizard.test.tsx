import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { InviteImportWizard } from '@/components/admin/questionnaires/invite-import-wizard';
import { DEFAULT_INVITEE_FIELDS } from '@/lib/app/questionnaire/types';

beforeEach(() => vi.clearAllMocks());

describe('InviteImportWizard', () => {
  it('shows a disabled message when there is no launched version', () => {
    render(
      <InviteImportWizard
        questionnaireId="qn-1"
        inviteeFields={DEFAULT_INVITEE_FIELDS}
        importEnabled={false}
        disabled
      />
    );
    expect(screen.getByText(/launch a version/i)).toBeInTheDocument();
  });

  it('hides the AI methods when import is disabled', () => {
    render(
      <InviteImportWizard
        questionnaireId="qn-1"
        inviteeFields={DEFAULT_INVITEE_FIELDS}
        importEnabled={false}
        disabled={false}
      />
    );
    expect(screen.getByRole('button', { name: /paste a list/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /csv upload/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pdf/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /image/i })).not.toBeInTheDocument();
  });

  it('parses a pasted list into the verify grid, then sends', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { results: [{ email: 'ada@x.com', outcome: 'sent' }] },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <InviteImportWizard
        questionnaireId="qn-1"
        inviteeFields={DEFAULT_INVITEE_FIELDS}
        importEnabled
        disabled={false}
      />
    );

    fireEvent.change(screen.getByLabelText(/paste a list of people/i), {
      target: { value: 'Ada Lovelace <ada@x.com>' },
    });
    fireEvent.click(screen.getByRole('button', { name: /parse list/i }));

    // Verify grid shows the parsed row (email prefilled).
    const emailInput = await screen.findByLabelText(/email row 1/i);
    expect(emailInput).toHaveValue('ada@x.com');

    fireEvent.click(screen.getByRole('button', { name: /send 1 invitation/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/app/questionnaires/qn-1/invitations',
        expect.objectContaining({ method: 'POST' })
      )
    );
    // Sent body carries the parsed recipient + profile.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipients[0]).toMatchObject({
      email: 'ada@x.com',
      profile: { firstName: 'Ada', surname: 'Lovelace' },
    });
    // Post-send summary.
    await screen.findByText(/1 sent/i);
  });
});
