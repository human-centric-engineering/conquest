/**
 * AuthedResumeChooser — the authenticated "Continue / Start new" screen (session resume).
 *
 * The server action is mocked (it pulls server-only deps); we pin the rendered choice: Continue links
 * to the existing session, and Start new invokes the abandon-old-then-create action.
 *
 * @see components/app/questionnaire/intro/authed-resume-chooser.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const actionMock = vi.hoisted(() => ({ startFreshAuthedSession: vi.fn() }));
vi.mock('@/app/(protected)/questionnaires/start/actions', () => actionMock);

import { AuthedResumeChooser } from '@/components/app/questionnaire/intro/authed-resume-chooser';

function renderChooser(props: Partial<React.ComponentProps<typeof AuthedResumeChooser>> = {}) {
  render(
    <AuthedResumeChooser
      versionId="v-1"
      sessionId="sess-1"
      refRaw="7F3K9M2P"
      answeredCount={2}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthedResumeChooser', () => {
  it('links Continue to the existing session', () => {
    renderChooser();
    const link = screen.getByRole('link', { name: /continue where you left off/i });
    expect(link).toHaveAttribute('href', '/questionnaires/sess-1');
  });

  it('shows the grouped ref and answered-count progress', () => {
    renderChooser();
    expect(screen.getByText('7F3K-9M2P')).toBeInTheDocument();
    expect(screen.getByText(/answered 2 questions so far/i)).toBeInTheDocument();
  });

  it('invokes the start-fresh action with the version + old session on Start new', async () => {
    const user = userEvent.setup();
    renderChooser();
    await user.click(screen.getByRole('button', { name: /start a new questionnaire/i }));
    expect(actionMock.startFreshAuthedSession).toHaveBeenCalledWith('v-1', 'sess-1');
  });

  it('singularises the progress line for a single answer', () => {
    renderChooser({ answeredCount: 1 });
    expect(screen.getByText(/answered 1 question so far/i)).toBeInTheDocument();
  });

  it('omits the ref line when the session has no ref', () => {
    renderChooser({ refRaw: null });
    expect(screen.queryByText(/Ref:/i)).not.toBeInTheDocument();
  });
});
