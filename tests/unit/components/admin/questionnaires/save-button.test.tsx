/**
 * SaveButton — a Save action that flashes a brief "Saved" check on success.
 *
 * These pin the saved-state contract the app-level save buttons rely on: the button
 * runs `onSave`, shows "Saving…" while it's in flight, then a "Saved" check that it
 * holds (self-disabled) before reverting to its idle label — and that it suppresses the
 * check when the handler throws or resolves `false` so a failed save doesn't read as done.
 *
 * @see components/admin/questionnaires/save-button.tsx
 */

import { StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SaveButton } from '@/components/admin/questionnaires/save-button';

describe('SaveButton', () => {
  it('renders the idle label and runs onSave on click', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(<SaveButton onSave={onSave}>Save configuration</SaveButton>);

    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('flashes a "Saved" confirmation after a successful save, then reverts', async () => {
    const user = userEvent.setup();
    render(
      <SaveButton onSave={() => Promise.resolve()} savedDurationMs={50}>
        Save configuration
      </SaveButton>
    );

    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument());
    // The check holds the button disabled so a stray second click can't re-fire.
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save configuration' })).toBeEnabled()
    );
  });

  it('does not show the check when onSave throws (handler owns the error)', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.reject(new Error('nope')));
    render(
      <SaveButton onSave={onSave} savedDurationMs={50}>
        Save changes
      </SaveButton>
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  });

  it('treats a resolved `false` as a failed save and suppresses the check', async () => {
    const user = userEvent.setup();
    render(
      <SaveButton onSave={() => Promise.resolve(false)} savedDurationMs={50}>
        Save changes
      </SaveButton>
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  });

  it('still reaches "Saved" under StrictMode (the mounted-ref must be restored on re-setup)', async () => {
    // Regression: StrictMode runs the mount effect setup → cleanup → setup. The cleanup flips the
    // internal `mounted` ref to false; if the setup doesn't restore it, a successful save's
    // `setPhase('saved')` is short-circuited and the button sticks spinning on "Saving…" forever
    // even though `onSave` resolved. Rendering under StrictMode exercises that double-invoke.
    const user = userEvent.setup();
    render(
      <StrictMode>
        <SaveButton onSave={() => Promise.resolve()} savedDurationMs={50}>
          Save configuration
        </SaveButton>
      </StrictMode>
    );

    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    // The phase must advance past "saving" — proving the guard wasn't tripped by a stale ref.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save configuration' })).toBeEnabled()
    );
  });

  it('stays disabled when the caller-supplied disabled flag is set', () => {
    render(
      <SaveButton onSave={() => Promise.resolve()} disabled>
        Save configuration
      </SaveButton>
    );
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  });
});
