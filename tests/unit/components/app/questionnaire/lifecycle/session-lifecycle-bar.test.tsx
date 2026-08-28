// @vitest-environment happy-dom

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
      displayCoverage: 0.9,
      answeredCount: 3,
      requiredUnansweredKeys: [],
      capReached: false,
      earlyFinishAvailable: false,
    },
    cost: null,
    anonymous: false,
    ref: null,
    experience: null,
    reopenAvailable: false,
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

  it('shows the percent-completed text by default', () => {
    renderBar();
    expect(screen.getByText('90% completed')).toBeInTheDocument();
  });

  it('hides the percent-completed text when showProgressPercentText is false, keeping the bar', () => {
    renderBar({ showProgressPercentText: false });
    expect(screen.queryByText(/completed/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /questionnaire progress/i })).toHaveAttribute(
      'aria-valuenow',
      '90'
    );
  });

  it('drives the bar off the graded displayCoverage, not the strict gate coverage', () => {
    // A session mid-capture: strict gate at 0% but graded display shows tentative momentum.
    renderBar({
      view: view({ completion: { ...view().completion, coverage: 0, displayCoverage: 0.4 } }),
    });
    const bar = screen.getByRole('progressbar', { name: /questionnaire progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
  });

  // The anonymity notice moved to the brand band above the conversation (under the questionnaire
  // title) so the strip keeps its row — the strip must not render a second copy of it.
  it('does not show an anonymity notice even when the session is anonymous', () => {
    renderBar({ view: view({ anonymous: true }) });
    expect(screen.queryByText(/responses are anonymous/i)).not.toBeInTheDocument();
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

  it('renders the session ref chip when the status view carries a ref', () => {
    renderBar({ view: view({ ref: 'EWG5GZTG' }) });
    // The info wrap-unit only renders when ref/download are present; the chip exposes the grouped
    // reference via its aria-label.
    expect(screen.getByRole('button', { name: /support reference/i })).toBeInTheDocument();
  });

  it('renders the download slot when one is supplied', () => {
    renderBar({ download: <button type="button">Download transcript</button> });
    expect(screen.getByRole('button', { name: /download transcript/i })).toBeInTheDocument();
  });

  it('renders the leading slot, and opens the strip for it even with nothing else to say', () => {
    // This is the fallback home for cross-device resume when the version has no intro splash to
    // carry it — so a leading slot has to be enough on its own to bring the strip into existence.
    renderBar({
      view: null,
      leading: <button type="button">Enter your code</button>,
    });
    expect(screen.getByRole('button', { name: /enter your code/i })).toBeInTheDocument();
  });
});

/**
 * The strip is two lines split by KIND, and the split is what buys the controls a single row.
 *
 * Everything used to right-align into one wrapping cluster — bar on top, then ref, download, text
 * size, switcher and review all fighting for the same `ml-auto` span. On a laptop that fragmented
 * into three ragged lines above the conversation. jsdom computes no layout, so what is asserted is
 * the arrangement that decides it: which line each part is on, and that the two lines are siblings
 * rather than one wrapping row.
 */
describe('status line vs control line', () => {
  /** The two lines are the strip root's element children, in order. */
  function lines(container: HTMLElement) {
    return Array.from(container.firstElementChild?.children ?? []) as HTMLElement[];
  }

  it('puts the reference and the download on the STATUS line, beside the bar', () => {
    // Both are facts about this session, not things that change what is on screen — and moving them
    // off the control line is precisely what gave the controls their row back.
    const { container } = renderBar({
      view: view({ ref: 'EWG5GZTG' }),
      download: <button type="button">Download transcript</button>,
      trailing: <button type="button">Review answers</button>,
    });

    const [status, controls] = lines(container);
    expect(status).toContainElement(screen.getByRole('button', { name: /support reference/i }));
    expect(status).toContainElement(screen.getByRole('button', { name: /download transcript/i }));
    expect(status).toContainElement(screen.getByRole('progressbar'));
    expect(controls).toContainElement(screen.getByRole('button', { name: /review answers/i }));
  });

  it('puts the leading switcher and the trailing tools on the SAME control line', () => {
    // The row's whole point: a left anchor and a trailing cluster, not two stacked right-aligned
    // fragments. If these ever land on different lines the "one row" claim is gone.
    const { container } = renderBar({
      view: view({ ref: 'EWG5GZTG' }),
      leading: <button type="button">Chat</button>,
      trailing: <button type="button">Review answers</button>,
    });

    const [, controls] = lines(container);
    expect(controls).toContainElement(screen.getByRole('button', { name: 'Chat' }));
    expect(controls).toContainElement(screen.getByRole('button', { name: /review answers/i }));
  });

  it('drops the control line entirely when there is nothing to operate', () => {
    // The common case — an anonymous active session with no pause control — is one thin bar and a
    // reference, and it must not pay for a second empty row.
    const { container } = renderBar({ view: view({ ref: 'EWG5GZTG' }) });
    expect(lines(container)).toHaveLength(1);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('drops the status line when there is no view and no reference', () => {
    const { container } = renderBar({
      view: null,
      trailing: <button type="button">Review answers</button>,
    });
    expect(lines(container)).toHaveLength(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
