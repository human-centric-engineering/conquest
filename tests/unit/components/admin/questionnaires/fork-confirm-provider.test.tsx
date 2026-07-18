/**
 * ForkConfirmProvider — mounts the single workspace fork-confirmation dialog and bridges it to
 * `authoringMutate`. It registers a handler on the bridge; invoking that handler opens the dialog
 * with the server-supplied lineage and resolves the awaiting promise with the admin's choice.
 *
 * The bridge is the REAL module here (we exercise register → request round-trip); only the dialog's
 * behaviour is observed through the DOM.
 *
 * @see components/admin/questionnaires/fork-confirm-provider.tsx
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ForkConfirmProvider } from '@/components/admin/questionnaires/fork-confirm-provider';
import {
  requestForkConfirm,
  type ForkConfirmDetails,
} from '@/components/admin/questionnaires/fork-confirm-bridge';

const DETAILS: ForkConfirmDetails = {
  sourceVersionNumber: 2,
  nextVersionNumber: 3,
  versions: [
    { versionNumber: 2, status: 'launched' },
    { versionNumber: 1, status: 'archived' },
  ],
};

beforeEach(() => {
  render(
    <ForkConfirmProvider>
      <div>child</div>
    </ForkConfirmProvider>
  );
});

describe('ForkConfirmProvider', () => {
  it('renders children and no dialog until a confirmation is requested', () => {
    expect(screen.getByText('child')).toBeInTheDocument();
    expect(screen.queryByText('Create a new draft version?')).not.toBeInTheDocument();
  });

  it('opens the dialog with the server lineage and resolves confirmed on confirm', async () => {
    const pending = requestForkConfirm(DETAILS);

    expect(await screen.findByText('Create a new draft version?')).toBeInTheDocument();
    // next = 3, branching from v2, both existing versions listed.
    expect(screen.getByRole('button', { name: 'Create draft v3 & save' })).toBeInTheDocument();
    expect(screen.getByText(/branching from this/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create draft v3 & save' }));
    // Archive checkbox left unticked → archiveSource false.
    await expect(pending).resolves.toEqual({ confirmed: true, archiveSource: false });
    // Dialog closes after settling.
    await waitFor(() =>
      expect(screen.queryByText('Create a new draft version?')).not.toBeInTheDocument()
    );
  });

  it('carries the archive-previous-version choice when the checkbox is ticked', async () => {
    const pending = requestForkConfirm(DETAILS);
    await screen.findByText('Create a new draft version?');

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Create draft v3 & save' }));

    await expect(pending).resolves.toEqual({ confirmed: true, archiveSource: true });
  });

  it('resolves declined on cancel', async () => {
    const pending = requestForkConfirm(DETAILS);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(pending).resolves.toEqual({ confirmed: false, archiveSource: false });
  });

  it('declines a second concurrent request instead of orphaning the first', async () => {
    // Two forking edits land near-simultaneously; only one dialog can show. The second must
    // resolve declined immediately (not overwrite the first's resolver, which would hang it).
    const first = requestForkConfirm(DETAILS);
    await screen.findByText('Create a new draft version?');
    const second = requestForkConfirm(DETAILS);
    await expect(second).resolves.toEqual({ confirmed: false, archiveSource: false });

    // The first is still live and resolves normally on confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Create draft v3 & save' }));
    await expect(first).resolves.toEqual({ confirmed: true, archiveSource: false });
  });

  it('settles a pending confirmation as cancelled when the provider unmounts', async () => {
    const { unmount } = render(
      <ForkConfirmProvider>
        <div>nav-away</div>
      </ForkConfirmProvider>
    );
    const pending = requestForkConfirm(DETAILS);
    await screen.findByText('Create a new draft version?');

    unmount(); // e.g. navigating away with the dialog still open
    await expect(pending).resolves.toEqual({ confirmed: false, archiveSource: false });
  });
});
