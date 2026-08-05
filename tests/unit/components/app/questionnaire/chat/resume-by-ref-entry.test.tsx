/**
 * @vitest-environment jsdom
 *
 * ResumeByRefEntry — the public-footer "continue on this device" affordance (session resume).
 *
 * Pins: the footer stays a single quiet line until asked, and the code entry opens in a dialog
 * that also tells the respondent WHERE their code is.
 *
 * @see components/app/questionnaire/chat/resume-by-ref-entry.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResumeByRefEntry } from '@/components/app/questionnaire/chat/resume-by-ref-entry';

describe('ResumeByRefEntry', () => {
  it('starts collapsed as a subtle trigger', () => {
    render(<ResumeByRefEntry versionId="v-1" />);
    expect(screen.getByRole('button', { name: /started on another device/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/session reference code/i)).not.toBeInTheDocument();
  });

  it('opens a dialog with the code field and where-to-find-it help', async () => {
    const user = userEvent.setup();
    render(<ResumeByRefEntry versionId="v-1" />);
    await user.click(screen.getByRole('button', { name: /started on another device/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/pick up where you left off/i);
    expect(dialog).toHaveTextContent(/at the bottom of the conversation/i);
    expect(screen.getByLabelText(/session reference code/i)).toBeInTheDocument();
  });
});
