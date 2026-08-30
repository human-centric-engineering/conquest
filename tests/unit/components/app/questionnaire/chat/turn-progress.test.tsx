// @vitest-environment happy-dom

/**
 * Unit tests: `TurnProgress` — the respondent's wait indicator (F20.2).
 *
 * Three behaviours carry the feature and all are easy to break silently: the label must never
 * collapse to nothing mid-wait (an empty indicator reads as "the reply arrived and was blank"),
 * the elapsed clock must stay hidden on a fast turn and appear on a slow one, and a stage change
 * must fade OUT before the next one appears rather than swapping under the reader's eye (F20.5).
 * The clock and the fade are both timer-driven, so these use fake timers.
 *
 * The DWELL between labels is not tested here: this component draws a change, it does not decide
 * when one happens. That is `usePacedStageLabel`, tested next to it.
 *
 * The a11y split is asserted too: exactly ONE live region, announcing the label and not the clock.
 * A screen reader being read a new number every second is noise, not reassurance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import {
  TurnProgress,
  ELAPSED_AFTER_MS,
  LABEL_FADE_MS,
  TURN_PROGRESS_FALLBACK,
} from '@/components/app/questionnaire/chat/turn-progress';

// The motion preference is an OS setting, so it is the one input here that cannot be driven through
// props. Held in a mutable box so a single test can flip it without a second `render` harness.
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/lib/hooks/use-prefers-reduced-motion', () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));

beforeEach(() => {
  motion.reduced = false;
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
    advance(LABEL_FADE_MS);

    expect(document.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Choosing what to ask next…'
    );
  });

  it('fades the old stage out before the new one appears, never both at once', () => {
    const { rerender } = render(<TurnProgress label="Reading your answer…" />);
    rerender(<TurnProgress label="Choosing what to ask next…" />);

    // Mid-hand-off: the outgoing words are still the ones on the row, on their way to transparent.
    // Painting the new label here instead would be the swap-under-the-eye this replaced, and
    // painting BOTH would be a smear — there is only one row.
    const label = screen.getByTestId('turn-progress-label');
    expect(label.textContent).toBe('Reading your answer…');
    expect(label.className).toContain('opacity-0');

    advance(LABEL_FADE_MS);
    expect(screen.getByTestId('turn-progress-label').textContent).toBe(
      'Choosing what to ask next…'
    );
    expect(screen.getByTestId('turn-progress-label').className).toContain('opacity-100');
  });

  it('swaps the words outright under reduced motion, with no fade to sit through', () => {
    // Fading over zero milliseconds is not the same as not fading: the fade path parks the OUTGOING
    // words at `opacity-0` and waits for a timer before painting the new ones. A reader who has
    // asked for less motion would get a blank row for that beat, which is worse than the motion.
    motion.reduced = true;
    const { rerender } = render(<TurnProgress label="Reading your answer…" />);
    rerender(<TurnProgress label="Choosing what to ask next…" />);

    // No timer advance — the new label is already on the row, fully opaque.
    const label = screen.getByTestId('turn-progress-label');
    expect(label.textContent).toBe('Choosing what to ask next…');
    expect(label.className).toContain('opacity-100');
    expect(label.className).not.toContain('opacity-0');
  });

  it('keeps a stage change to one row, so the turn mark stays level with the words', () => {
    // `AssistantTurn` pins the interviewer's accent mark to the FIRST line of the turn. A second
    // row here — an earlier build scrolled the outgoing label away above the live one — left that
    // mark floating a row above the text it belongs to.
    const { container, rerender } = render(<TurnProgress label="Reading your answer…" />);
    rerender(<TurnProgress label="Choosing what to ask next…" />);
    advance(LABEL_FADE_MS);

    const row = container.querySelector('[role="status"]');
    expect(row?.className).toContain('min-h-6');
    expect(screen.getAllByTestId('turn-progress-label')).toHaveLength(1);
  });

  it('holds still for a label that has not actually changed', () => {
    const { rerender } = render(<TurnProgress label="Reading your answer…" />);
    rerender(<TurnProgress label="Reading your answer…" />);

    // The stream re-renders for reasons that have nothing to do with the stage — a content delta,
    // a new turn committing. Fading on every render would make the row flicker continuously.
    expect(screen.getByTestId('turn-progress-label').className).toContain('opacity-100');
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
