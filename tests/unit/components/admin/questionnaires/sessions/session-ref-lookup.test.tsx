import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const get = vi.fn();
vi.mock('@/lib/api/client', () => ({ apiClient: { get: (...args: unknown[]) => get(...args) } }));

import { SessionRefLookup } from '@/components/admin/questionnaires/sessions/session-ref-lookup';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionRefLookup', () => {
  it('resolves the reference and navigates to the returned session viewer location', async () => {
    get.mockResolvedValue({ sessionId: 'sess-9', questionnaireId: 'qn-2', versionId: 'ver-3' });

    render(<SessionRefLookup />);
    fireEvent.change(screen.getByLabelText('Session reference'), {
      target: { value: '7F3K-9M2P' },
    });
    fireEvent.click(screen.getByRole('button', { name: /view session/i }));

    await waitFor(() =>
      // Navigates using the API-returned location, not the current params.
      expect(push).toHaveBeenCalledWith('/admin/questionnaires/qn-2/v/ver-3/sessions/sess-9')
    );
    expect(get).toHaveBeenCalledWith(expect.stringContaining('7F3K-9M2P'));
  });

  it('surfaces the API error message and does not navigate', async () => {
    get.mockRejectedValue(new Error('No session found for that reference'));

    render(<SessionRefLookup />);
    fireEvent.change(screen.getByLabelText('Session reference'), { target: { value: 'BAD-REF' } });
    fireEvent.click(screen.getByRole('button', { name: /view session/i }));

    expect(await screen.findByText('No session found for that reference')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('disables the button while the input is empty', () => {
    render(<SessionRefLookup />);
    expect(screen.getByRole('button', { name: /view session/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Session reference'), { target: { value: 'X' } });
    expect(screen.getByRole('button', { name: /view session/i })).toBeEnabled();
  });

  it('renders the compact variant with a shorter button label', () => {
    render(<SessionRefLookup compact />);
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    // The panel-only heading is absent in compact mode.
    expect(screen.queryByText('View a session')).not.toBeInTheDocument();
  });
});
