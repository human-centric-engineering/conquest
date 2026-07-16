/**
 * SessionResumeGate — the no-login "welcome back" chooser (session resume).
 *
 * @see components/app/questionnaire/chat/session-resume-gate.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionResumeGate } from '@/components/app/questionnaire/chat/session-resume-gate';

function renderGate(props: Partial<React.ComponentProps<typeof SessionResumeGate>> = {}) {
  const onContinue = vi.fn();
  const onStartNew = vi.fn();
  render(
    <SessionResumeGate
      versionId="v-1"
      refRaw="7F3K9M2P"
      answeredCount={3}
      onContinue={onContinue}
      onStartNew={onStartNew}
      busy={false}
      {...props}
    />
  );
  return { onContinue, onStartNew };
}

describe('SessionResumeGate', () => {
  it('shows the grouped ref and the answered-count progress', () => {
    renderGate();
    expect(screen.getByText('7F3K-9M2P')).toBeInTheDocument();
    expect(screen.getByText(/answered 3 questions so far/i)).toBeInTheDocument();
  });

  it('singularises the progress line for a single answer', () => {
    renderGate({ answeredCount: 1 });
    expect(screen.getByText(/answered 1 question so far/i)).toBeInTheDocument();
  });

  it('fires onContinue and onStartNew from the two buttons', async () => {
    const user = userEvent.setup();
    const { onContinue, onStartNew } = renderGate();
    await user.click(screen.getByRole('button', { name: /continue where you left off/i }));
    expect(onContinue).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /start a new questionnaire/i }));
    expect(onStartNew).toHaveBeenCalledOnce();
  });

  it('disables both actions while busy', () => {
    renderGate({ busy: true });
    expect(screen.getByRole('button', { name: /start a new questionnaire/i })).toBeDisabled();
    // The Continue CTA swaps to a spinner while busy — its accessible name is no longer the label.
    expect(
      screen.queryByRole('button', { name: /continue where you left off/i })
    ).not.toBeInTheDocument();
  });

  it('reveals the cross-device ref form on demand', async () => {
    const user = userEvent.setup();
    renderGate();
    expect(screen.queryByLabelText(/session reference code/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /started on another device/i }));
    expect(screen.getByLabelText(/session reference code/i)).toBeInTheDocument();
  });

  it('omits the ref line when the session has no ref', () => {
    renderGate({ refRaw: null });
    expect(screen.queryByText(/Ref:/i)).not.toBeInTheDocument();
  });
});
