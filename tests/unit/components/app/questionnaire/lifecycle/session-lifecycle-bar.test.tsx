/**
 * SessionLifecycleBar — anon badge, pause/resume gating, cost hint, action error (F7.3).
 *
 * @see components/app/questionnaire/lifecycle/session-lifecycle-bar.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionLifecycleBar } from '@/components/app/questionnaire/lifecycle/session-lifecycle-bar';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

function view(over: Partial<SessionStatusView> = {}): SessionStatusView {
  return {
    status: 'active',
    completion: {
      kind: 'offer',
      coverage: 0.9,
      answeredCount: 3,
      requiredUnansweredKeys: [],
      capReached: false,
    },
    cost: null,
    anonymous: false,
    ref: null,
    ...over,
  };
}

const noop = () => {};

function renderBar(props: Partial<React.ComponentProps<typeof SessionLifecycleBar>> = {}) {
  return render(
    <SessionLifecycleBar
      view={view()}
      paused={false}
      busy={false}
      actionError={null}
      canPause={false}
      canResume={false}
      onPause={noop}
      onResume={noop}
      {...props}
    />
  );
}

describe('SessionLifecycleBar', () => {
  it('renders nothing when there is no status view', () => {
    const { container } = renderBar({ view: null });
    expect(container.firstChild).toBeNull();
  });

  it('shows the coverage progress bar whenever there is a status view', () => {
    renderBar();
    const bar = screen.getByRole('progressbar', { name: /questionnaire progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '90');
  });

  it('shows the anonymous indicator when the session is anonymous', () => {
    renderBar({ view: view({ anonymous: true }) });
    expect(screen.getByText(/responses are anonymous/i)).toBeInTheDocument();
  });

  it('shows a Pause control for an authed active session and fires onPause', async () => {
    const onPause = vi.fn();
    renderBar({ canPause: true, onPause });
    const btn = screen.getByRole('button', { name: /pause/i });
    await userEvent.click(btn);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('shows a Resume control + paused notice when respondent-paused', async () => {
    const onResume = vi.fn();
    renderBar({ paused: true, canResume: true, onResume });
    expect(screen.getByText(/paused — your progress is saved/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('shows the soft cost hint only while not paused', () => {
    const { rerender } = renderBar({ view: view({ cost: { tier: 'soft' } }) });
    expect(screen.getByText(/approaching this session/i)).toBeInTheDocument();
    rerender(
      <SessionLifecycleBar
        view={view({ cost: { tier: 'soft' } })}
        paused
        busy={false}
        actionError={null}
        canPause={false}
        canResume
        onPause={noop}
        onResume={noop}
      />
    );
    expect(screen.queryByText(/approaching this session/i)).not.toBeInTheDocument();
  });

  it('disables the controls while busy', () => {
    renderBar({ canPause: true, busy: true });
    expect(screen.getByRole('button', { name: /pause/i })).toBeDisabled();
  });

  it('surfaces an action error', () => {
    renderBar({ canPause: true, actionError: 'Could not pause' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not pause');
  });
});
