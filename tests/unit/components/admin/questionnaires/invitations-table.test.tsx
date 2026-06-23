import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { InvitationsTable } from '@/components/admin/questionnaires/invitations-table';
import type { InvitationView } from '@/lib/app/questionnaire/invitations';

function inv(overrides: Partial<InvitationView> = {}): InvitationView {
  return {
    id: 'inv-1',
    email: 'a@x.com',
    name: 'Al',
    status: 'sent',
    versionId: 'v1',
    versionNumber: 2,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    sentAt: new Date().toISOString(),
    openedAt: null,
    registeredAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvitationsTable', () => {
  it('shows the invited → started → completed stage tally (excluding revoked)', () => {
    render(
      <InvitationsTable
        questionnaireId="qn-1"
        invitations={[
          inv({ id: '1', status: 'sent' }),
          inv({ id: '2', status: 'started' }),
          inv({ id: '3', status: 'completed' }),
          inv({ id: '4', status: 'revoked' }), // excluded from all counts
        ]}
      />
    );
    // 3 non-revoked invited, 1 started, 1 completed.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getAllByText('1')).toHaveLength(2); // started + completed
  });

  it('"Get link" POSTs the link route and reveals the URL in a dialog (not silently copied)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { url: 'https://app/q/v1?i=tok', expiresAt: new Date().toISOString() },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsTable questionnaireId="qn-1" invitations={[inv({ status: 'sent' })]} />);

    fireEvent.click(screen.getByRole('button', { name: /get link/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/app/questionnaires/qn-1/invitations/inv-1/link',
        expect.objectContaining({ method: 'POST' })
      )
    );
    // The URL is shown to the admin, not just written to the clipboard.
    expect(await screen.findByDisplayValue('https://app/q/v1?i=tok')).toBeInTheDocument();
    // The rotation warning is surfaced so the admin understands the side effect.
    expect(screen.getByText(/invalidated any previous link/i)).toBeInTheDocument();
  });

  it('surfaces the server error message when link generation is rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        success: false,
        error: { code: 'NOT_ALLOWED', message: 'Not allowed' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsTable questionnaireId="qn-1" invitations={[inv({ status: 'sent' })]} />);
    fireEvent.click(screen.getByRole('button', { name: /get link/i }));

    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    // No reveal dialog opens on failure.
    expect(screen.queryByText(/invalidated any previous link/i)).not.toBeInTheDocument();
  });

  it('surfaces a generic error when the link request throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsTable questionnaireId="qn-1" invitations={[inv({ status: 'sent' })]} />);
    fireEvent.click(screen.getByRole('button', { name: /get link/i }));

    expect(await screen.findByText(/could not generate a link/i)).toBeInTheDocument();
  });

  it('hides "Get link" for a revoked invitation', () => {
    render(<InvitationsTable questionnaireId="qn-1" invitations={[inv({ status: 'revoked' })]} />);
    expect(screen.queryByRole('button', { name: /get link/i })).not.toBeInTheDocument();
  });
});
