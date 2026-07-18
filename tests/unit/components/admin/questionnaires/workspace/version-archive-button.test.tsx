/**
 * VersionArchiveButton — the per-row Archive/Restore control in the Overview version timeline.
 *
 * Covers: label by state (Archive vs Restore), the hook call routed by `archived`, the
 * `router.refresh()` on success (and NOT on failure), pending-disable, and the inline error.
 *
 * @see components/admin/questionnaires/workspace/version-archive-button.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const archive = vi.fn();
const restore = vi.fn();
const hookState = { isPending: false, error: null as string | null };
vi.mock('@/components/admin/questionnaires/use-archive-version', () => ({
  useArchiveVersion: () => ({
    archive,
    restore,
    isPending: hookState.isPending,
    error: hookState.error,
  }),
}));

import { VersionArchiveButton } from '@/components/admin/questionnaires/workspace/version-archive-button';

beforeEach(() => {
  vi.clearAllMocks();
  hookState.isPending = false;
  hookState.error = null;
  archive.mockResolvedValue(true);
  restore.mockResolvedValue(true);
});

describe('VersionArchiveButton', () => {
  it('renders "Archive" and archives + refreshes on success when not archived', async () => {
    render(<VersionArchiveButton questionnaireId="qn-1" versionId="v-1" archived={false} />);
    const btn = screen.getByRole('button', { name: 'Archive' });

    fireEvent.click(btn);

    await waitFor(() => expect(archive).toHaveBeenCalledWith('qn-1', 'v-1'));
    expect(restore).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('renders "Restore" and restores + refreshes on success when archived', async () => {
    render(<VersionArchiveButton questionnaireId="qn-1" versionId="v-2" archived />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith('qn-1', 'v-2'));
    expect(archive).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('does NOT refresh when the mutation fails', async () => {
    archive.mockResolvedValue(false);
    render(<VersionArchiveButton questionnaireId="qn-1" versionId="v-1" archived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archive).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables the button while a mutation is pending', () => {
    hookState.isPending = true;
    render(<VersionArchiveButton questionnaireId="qn-1" versionId="v-1" archived={false} />);
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
  });

  it('surfaces the hook error inline', () => {
    hookState.error = 'Could not archive the version.';
    render(<VersionArchiveButton questionnaireId="qn-1" versionId="v-1" archived={false} />);
    expect(screen.getByText('Could not archive the version.')).toBeInTheDocument();
  });
});
