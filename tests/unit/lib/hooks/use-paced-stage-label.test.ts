// @vitest-environment happy-dom

/**
 * Unit tests: `usePacedStageLabel` — the dwell that makes the wait indicator readable (F20.5).
 *
 * The bug this exists for is a sequence that is TRUE and unreadable: the orchestrator can cross two
 * stage boundaries inside a second, and the labels then flash past faster than anyone can read
 * them. So the properties worth pinning are the ones a careless rewrite would lose — that a label
 * arriving mid-dwell is QUEUED rather than dropped or swapped in, that order survives, and that a
 * turn ending wipes the queue rather than draining it into the next turn's wait.
 *
 * Everything here is timer-driven, so the whole file runs on fake timers (which mock `Date.now`
 * too — the hook schedules against an absolute stamp, not a countdown).
 */

import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePacedStageLabel, STAGE_MIN_DWELL_MS } from '@/lib/hooks/use-paced-stage-label';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Mount with no label, as the provider does — a session opens before any turn is in flight. */
function mount() {
  return renderHook(({ label }: { label: string | null }) => usePacedStageLabel(label), {
    initialProps: { label: null as string | null },
  });
}

describe('usePacedStageLabel', () => {
  it('puts the first label of a turn up at once', () => {
    const { result, rerender } = mount();
    expect(result.current).toBeNull();

    rerender({ label: 'Reading your answer…' });
    advance(0);

    // No artificial hold at the start: the dwell exists to stop labels overwriting each other,
    // not to sit on the neutral opener after the server has said what it is doing.
    expect(result.current).toBe('Reading your answer…');
  });

  it('holds a label for the dwell before letting the next one replace it', () => {
    const { result, rerender } = mount();
    rerender({ label: 'Reading your answer…' });
    advance(0);

    rerender({ label: 'Choosing what to ask next…' });
    advance(STAGE_MIN_DWELL_MS - 1);
    // The stage genuinely changed a moment ago — but a sentence swapped out this fast is motion
    // the respondent registers and cannot read, which is the whole defect.
    expect(result.current).toBe('Reading your answer…');

    advance(1);
    expect(result.current).toBe('Choosing what to ask next…');
  });

  it('queues a burst rather than dropping it, and keeps the order', () => {
    const { result, rerender } = mount();
    rerender({ label: 'Reading your answer…' });
    advance(0);

    // Both boundaries crossed while the first label is still serving its dwell.
    rerender({ label: "Checking that against what you've told me…" });
    rerender({ label: 'Choosing what to ask next…' });
    expect(result.current).toBe('Reading your answer…');

    advance(STAGE_MIN_DWELL_MS);
    // Skipping straight to the newest would silently drop a stage the turn really did run.
    expect(result.current).toBe("Checking that against what you've told me…");

    advance(STAGE_MIN_DWELL_MS);
    expect(result.current).toBe('Choosing what to ask next…');
  });

  it('ignores a label repeated back to back', () => {
    const { result, rerender } = mount();
    rerender({ label: 'Reading your answer…' });
    advance(0);

    rerender({ label: 'Reading your answer…' });
    rerender({ label: 'Choosing what to ask next…' });

    // Queued twice, the repeat would cost the NEXT stage a whole extra dwell and read as the
    // surface having stalled and restarted on the same sentence.
    advance(STAGE_MIN_DWELL_MS);
    expect(result.current).toBe('Choosing what to ask next…');
  });

  it('queues a label once even when the effect runs twice for it', () => {
    // React 19 StrictMode sets every effect up, tears it down and sets it up again ON MOUNT, so a
    // provider that mounts mid-turn — with a stage already on the stream — genuinely runs the
    // effect body twice for one label. That is the case `next === lastSeen.current` exists for.
    // Without the guard the queue holds the same sentence twice, and the NEXT stage waits a second
    // dwell behind a repeat of the first, which reads as the surface having stalled and restarted.
    const { result, rerender } = renderHook(
      ({ label }: { label: string | null }) => usePacedStageLabel(label),
      {
        initialProps: { label: 'Reading your answer…' },
        wrapper: StrictMode,
      }
    );
    advance(0);
    expect(result.current).toBe('Reading your answer…');

    rerender({ label: 'Choosing what to ask next…' });
    advance(STAGE_MIN_DWELL_MS);

    // One dwell, not two: the second stage is up, not stuck behind a duplicate of the first.
    expect(result.current).toBe('Choosing what to ask next…');
  });

  it('clears immediately when the turn ends, and drops whatever was queued', () => {
    const { result, rerender } = mount();
    rerender({ label: 'Reading your answer…' });
    advance(0);
    rerender({ label: 'Choosing what to ask next…' });

    // The stream clears the label on the first content delta and again in teardown.
    rerender({ label: null });
    expect(result.current).toBeNull();

    advance(STAGE_MIN_DWELL_MS * 3);
    // A queued stage surfacing after the reply has started — or beside the NEXT turn's wait —
    // would be the indicator describing work that is already finished.
    expect(result.current).toBeNull();
  });

  it('treats a blank label as no label', () => {
    const { result, rerender } = mount();
    rerender({ label: 'Reading your answer…' });
    advance(0);

    rerender({ label: '   ' });
    expect(result.current).toBeNull();
  });

  it('starts the next turn without waiting on the previous dwell', () => {
    const { result, rerender } = mount();
    rerender({ label: 'Reading your answer…' });
    advance(0);
    rerender({ label: null });

    rerender({ label: 'Reading your answer…' });
    advance(0);

    expect(result.current).toBe('Reading your answer…');
  });

  it('stops its timer on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { rerender, unmount } = mount();
    rerender({ label: 'Reading your answer…' });

    unmount();

    // One live timer per mounted session is small, but a promotion firing into an unmounted tree
    // is a React warning in dev and a torn-down environment in a test run.
    expect(clearSpy).toHaveBeenCalled();
  });
});
