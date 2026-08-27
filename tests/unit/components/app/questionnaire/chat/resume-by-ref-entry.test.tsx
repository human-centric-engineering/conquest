// @vitest-environment jsdom

/**
 * ResumeByRefEntry — the public-footer "continue on this device" affordance (session resume).
 *
 * Pins: the trigger stays a quiet two-line footnote (never a rival button to the splash CTA it sits
 * beside), keeps its full accessible name at every width, and the code entry opens in a dialog that
 * also tells the respondent WHERE their code is.
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

  it('keeps a footnote weight — not a second call-to-action competing with the CTA', () => {
    render(<ResumeByRefEntry versionId="v-1" />);
    const trigger = screen.getByRole('button', { name: /started on another device/i });
    // No pill: an outlined chip under the conversation reads as a rival button to "Begin your
    // conversation". The action word carries the emphasis instead.
    expect(trigger.className).not.toMatch(/\bborder\b/);
    expect(screen.getByText('Enter your code').className).toContain('underline');
  });

  it('stacks the action under the question, unabridged at every width', () => {
    // Stacking is what lets the full sentence survive on a phone — nothing is `sm:`-hidden, so the
    // accessible name is never abridged on exactly the devices most likely to BE the second device.
    render(<ResumeByRefEntry versionId="v-1" />);
    const trigger = screen.getByRole('button', { name: /started on another device/i });

    expect(trigger.className).toContain('flex-col');
    expect(trigger.className).toContain('text-center');
    expect(screen.getByText('Already started on another device?').className).not.toContain(
      'hidden'
    );
    expect(trigger).toHaveAccessibleName(/already started on another device\?\s*enter your code/i);
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
