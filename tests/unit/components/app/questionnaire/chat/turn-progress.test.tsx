// @vitest-environment happy-dom

/**
 * Unit tests: `TurnProgress` — the respondent's wait indicator (F20.2).
 *
 * Two behaviours carry the feature and both are easy to break silently: the label must never
 * collapse to nothing mid-wait (an empty indicator reads as "the reply arrived and was blank"),
 * and the elapsed clock must stay hidden on a fast turn and appear on a slow one. The clock is
 * driven by a real interval, so these use fake timers.
 *
 * The a11y split is asserted too: exactly ONE live region, announcing the label and not the clock.
 * A screen reader being read a new number every second is noise, not reassurance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import {
  TurnProgress,
  ELAPSED_AFTER_MS,
  TURN_PROGRESS_FALLBACK,
} from '@/components/app/questionnaire/chat/turn-progress';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance the clock inside `act` so the interval's setState is flushed. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('TurnProgress', () => {
  it('shows the live stage label the server sent', () => {
    render(<TurnProgress label="Choosing what to ask next…" />);

    expect(screen.getByText('Choosing what to ask next…')).toBeTruthy();
  });

  it('falls back to a neutral label rather than rendering an empty indicator', () => {
    // Null is the normal state for the first beat of every turn, before the first status frame.
    const { rerender } = render(<TurnProgress label={null} />);
    expect(screen.getByText(TURN_PROGRESS_FALLBACK)).toBeTruthy();

    // A blank string is the defensive case — it must not blank the row either.
    rerender(<TurnProgress label="   " />);
    expect(screen.getByText(TURN_PROGRESS_FALLBACK)).toBeTruthy();
  });

  it('hides the clock on a turn that finishes quickly', () => {
    render(<TurnProgress label="Reading your answer…" />);

    advance(ELAPSED_AFTER_MS - 1_000);

    // A clock on a sub-4s turn is clutter that makes a normal wait look like a problem.
    expect(screen.queryByTestId('turn-elapsed')).toBeNull();
  });

  it('reveals the clock once the wait passes the threshold, and keeps counting', () => {
    render(<TurnProgress label="Writing the next question…" />);

    advance(ELAPSED_AFTER_MS);
    expect(screen.getByTestId('turn-elapsed').textContent).toBe('00:04');

    advance(8_000);
    expect(screen.getByTestId('turn-elapsed').textContent).toBe('00:12');
  });

  it('rolls past a minute rather than counting seconds forever', () => {
    render(<TurnProgress label="Reading your answer…" />);

    advance(75_000);

    expect(screen.getByTestId('turn-elapsed').textContent).toBe('01:15');
  });

  it('never shows a clock when the caller opts out', () => {
    // The composer's cue sits beside the transcript's; two running clocks on one wait is noise.
    render(<TurnProgress label="Reading your answer…" showElapsed={false} />);

    advance(30_000);

    expect(screen.queryByTestId('turn-elapsed')).toBeNull();
  });

  it('announces the label through exactly one live region, and never the clock', () => {
    render(<TurnProgress label="Reading your answer…" />);
    advance(ELAPSED_AFTER_MS);

    const regions = document.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('aria-label')).toBe('Reading your answer…');
    // The ticking number is decorative: hidden from the a11y tree so it is not read out each second.
    expect(screen.getByTestId('turn-elapsed').getAttribute('aria-hidden')).toBe('true');
  });

  it('updates the announced label when the stage changes', () => {
    const { rerender } = render(<TurnProgress label="Reading your answer…" />);
    rerender(<TurnProgress label="Choosing what to ask next…" />);

    expect(document.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Choosing what to ask next…'
    );
    expect(screen.queryByText('Reading your answer…')).toBeNull();
  });

  it('stops its interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<TurnProgress label="Reading your answer…" />);

    unmount();

    // The component mounts and unmounts once per turn; a leaked interval would accumulate one
    // live timer per turn for the length of a session.
    expect(clearSpy).toHaveBeenCalled();
  });
});
