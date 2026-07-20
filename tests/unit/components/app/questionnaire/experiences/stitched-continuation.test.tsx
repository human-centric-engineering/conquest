/**
 * StitchedContinuation (P15.3) — the seam under `stitched` continuity.
 *
 * The behaviour that distinguishes it from `HandoffCard` is that it continues on its own. These
 * tests pin that, and pin the two things that must NOT auto-continue: an ending, and a repeat.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const handoffMock = vi.hoisted(() => ({ useRunHandoff: vi.fn() }));
vi.mock('@/lib/hooks/use-run-handoff', () => handoffMock);

import { StitchedContinuation } from '@/components/app/questionnaire/experiences/stitched-continuation';
import type { RunPollState } from '@/lib/app/questionnaire/experiences/run/types';

function renderAt(state: RunPollState, overrides: Partial<{ onContinue: () => void }> = {}) {
  handoffMock.useRunHandoff.mockReturnValue(state);
  const onContinue = overrides.onContinue ?? vi.fn();
  const onSettled = vi.fn();
  const utils = render(
    <StitchedContinuation
      runId="run_1"
      sessionId="sess_a"
      onContinue={onContinue}
      onSettled={onSettled}
    />
  );
  return { onContinue, onSettled, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('while the fork is resolving', () => {
  it('renders a wordless composing indicator, not a card', async () => {
    renderAt({ state: 'pending' });

    // Announced to assistive tech, but carrying no copy that would name the seam `stitched`
    // exists to hide.
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Composing the next question');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not continue', () => {
    const { onContinue, onSettled } = renderAt({ state: 'pending' });
    expect(onContinue).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe('when the fork resolves onward', () => {
  it('continues on its own — no button, no tap', async () => {
    const { onContinue, onSettled } = renderAt({
      state: 'leg',
      sessionId: 'sess_b',
      stepTitle: 'Team depth',
      message: 'Carrying on',
      sessionToken: 'tok_b',
    });

    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('sess_b', 'tok_b'));
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('continues exactly once across re-renders', async () => {
    const state: RunPollState = {
      state: 'leg',
      sessionId: 'sess_b',
      stepTitle: 'Team depth',
      message: 'Carrying on',
    };
    handoffMock.useRunHandoff.mockReturnValue(state);
    const onContinue = vi.fn();
    const { rerender } = render(
      <StitchedContinuation
        runId="run_1"
        sessionId="sess_a"
        onContinue={onContinue}
        onSettled={vi.fn()}
      />
    );

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    // A parent re-render between the call and the actual navigation must not fire a second one.
    rerender(
      <StitchedContinuation
        runId="run_1"
        sessionId="sess_a"
        onContinue={onContinue}
        onSettled={vi.fn()}
      />
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('when the journey ends', () => {
  it('settles rather than continuing, so the ending can be read', async () => {
    const { onContinue, onSettled } = renderAt({
      state: 'conclude',
      reason: 'selector',
      message: "That's everything",
    });

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled.mock.calls[0][0]).toMatchObject({ state: 'conclude' });
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('settles on a failed handoff too', async () => {
    const { onContinue, onSettled } = renderAt({ state: 'failed', message: 'Taking too long' });

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled.mock.calls[0][0]).toMatchObject({ state: 'failed' });
    expect(onContinue).not.toHaveBeenCalled();
  });
});
