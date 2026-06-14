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

  it('copy-link POSTs the link route, copies the URL, and flips to "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { url: 'https://app/q/v1?i=tok' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsTable questionnaireId="qn-1" invitations={[inv({ status: 'sent' })]} />);

    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app/q/v1?i=tok'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn-1/invitations/inv-1/link',
      expect.objectContaining({ method: 'POST' })
    );
    await screen.findByText('Copied');
  });

  it('hides copy-link for a revoked invitation', () => {
    render(<InvitationsTable questionnaireId="qn-1" invitations={[inv({ status: 'revoked' })]} />);
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
  });
});
