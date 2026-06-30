/**
 * useHorizontalSwipe — follow-the-gesture horizontal carousel driver (touch + trackpad wheel).
 *
 * @see lib/hooks/use-horizontal-swipe.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  useHorizontalSwipe,
  type UseHorizontalSwipeOptions,
} from '@/lib/hooks/use-horizontal-swipe';

/** A frame width of 1000 makes the commit threshold a round 200px (COMMIT_RATIO 0.2). */
const WIDTH = 1000;

function setup(over: Partial<UseHorizontalSwipeOptions> = {}) {
  const onCommitNext = vi.fn();
  const onCommitPrev = vi.fn();
  const options: UseHorizontalSwipeOptions = {
    onCommitNext,
    onCommitPrev,
    canPrev: true,
    canNext: true,
    getWidth: () => WIDTH,
    ...over,
  };
  const hook = renderHook((props: UseHorizontalSwipeOptions) => useHorizontalSwipe(props), {
    initialProps: options,
  });
  return { hook, onCommitNext, onCommitPrev };
}

/** Minimal React.TouchEvent stub — the hook only reads touches/changedTouches clientX/clientY. */
function touch(x: number, y: number) {
  const t = [{ clientX: x, clientY: y }];
  return { touches: t, changedTouches: t } as unknown as React.TouchEvent;
}

describe('useHorizontalSwipe', () => {
  describe('touch', () => {
    it('follows the finger 1:1 once the gesture is horizontal-dominant', () => {
      const { hook } = setup();
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      // A move that clears the 10px axis-decision threshold, horizontally dominant.
      act(() => hook.result.current.onTouchMove(touch(460, 305)));
      expect(hook.result.current.dragPx).toBe(-40);
      act(() => hook.result.current.onTouchMove(touch(420, 308)));
      expect(hook.result.current.dragPx).toBe(-80);
    });

    it('commits next when the drag clears the threshold leftward', () => {
      const { hook, onCommitNext, onCommitPrev } = setup();
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      act(() => hook.result.current.onTouchMove(touch(480, 300)));
      act(() => hook.result.current.onTouchEnd(touch(250, 300))); // travel -250, past -200
      expect(onCommitNext).toHaveBeenCalledTimes(1);
      expect(onCommitPrev).not.toHaveBeenCalled();
      // Track springs back to rest and animates the settle.
      expect(hook.result.current.dragPx).toBe(0);
      expect(hook.result.current.animating).toBe(true);
    });

    it('commits prev when the drag clears the threshold rightward', () => {
      const { hook, onCommitNext, onCommitPrev } = setup();
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      act(() => hook.result.current.onTouchMove(touch(520, 300)));
      act(() => hook.result.current.onTouchEnd(touch(750, 300))); // travel +250
      expect(onCommitPrev).toHaveBeenCalledTimes(1);
      expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('does not commit a short drag that never clears the threshold', () => {
      const { hook, onCommitNext, onCommitPrev } = setup();
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      act(() => hook.result.current.onTouchMove(touch(480, 300)));
      act(() => hook.result.current.onTouchEnd(touch(420, 300))); // travel -80, under -200
      expect(onCommitNext).not.toHaveBeenCalled();
      expect(onCommitPrev).not.toHaveBeenCalled();
    });

    it('abandons a vertical-dominant gesture (hands it back to scroll)', () => {
      const { hook, onCommitNext } = setup();
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      act(() => hook.result.current.onTouchMove(touch(505, 360))); // dy dominant
      expect(hook.result.current.dragPx).toBe(0);
      act(() => hook.result.current.onTouchEnd(touch(505, 500)));
      expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('ignores multi-touch gestures (pinch/zoom)', () => {
      const { hook, onCommitNext } = setup();
      const pinch = {
        touches: [
          { clientX: 100, clientY: 100 },
          { clientX: 300, clientY: 100 },
        ],
        changedTouches: [{ clientX: 100, clientY: 100 }],
      } as unknown as React.TouchEvent;
      act(() => hook.result.current.onTouchStart(pinch));
      act(() => hook.result.current.onTouchMove(touch(50, 100)));
      expect(hook.result.current.dragPx).toBe(0);
      act(() => hook.result.current.onTouchEnd(touch(50, 100)));
      expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('rubber-bands (damped, no commit) when dragging past an edge with no neighbour', () => {
      const { hook, onCommitNext } = setup({ canNext: false });
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      act(() => hook.result.current.onTouchMove(touch(480, 300)));
      act(() => hook.result.current.onTouchMove(touch(200, 300))); // raw -300
      // Damped to raw * EDGE_DAMP (0.3) = -90, still within the -120 hard cap.
      expect(hook.result.current.dragPx).toBe(-90);
      act(() => hook.result.current.onTouchEnd(touch(200, 300)));
      expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('springs back when a second finger interrupts an active drag (pinch)', () => {
      const { hook } = setup();
      act(() => hook.result.current.onTouchStart(touch(500, 300)));
      act(() => hook.result.current.onTouchMove(touch(440, 305))); // horizontal drag → dragPx -60
      expect(hook.result.current.dragPx).toBe(-60);
      // A second finger lands (pinch). onTouchEnd will bail on the cleared start, so onTouchStart
      // itself must spring the partial drag back rather than leaving the surface frozen at -60.
      const pinch = {
        touches: [
          { clientX: 440, clientY: 305 },
          { clientX: 600, clientY: 305 },
        ],
        changedTouches: [{ clientX: 440, clientY: 305 }],
      } as unknown as React.TouchEvent;
      act(() => hook.result.current.onTouchStart(pinch));
      expect(hook.result.current.dragPx).toBe(0);
      expect(hook.result.current.animating).toBe(true);
    });
  });

  describe('wheel', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('ignores a vertical-dominant wheel (returns false, no preventDefault)', () => {
      const { hook } = setup();
      let consumed = true;
      act(() => {
        consumed = hook.result.current.handleWheel(5, 40);
      });
      expect(consumed).toBe(false);
    });

    it('consumes a horizontal wheel burst and reports the live offset', () => {
      const { hook } = setup();
      let consumed = false;
      act(() => {
        consumed = hook.result.current.handleWheel(-30, 2); // right-swipe deltaX negative
      });
      expect(consumed).toBe(true);
      expect(hook.result.current.dragPx).toBe(30); // accumulates -deltaX
    });

    it('commits instantly once a hard wheel burst crosses 200px', () => {
      const { hook, onCommitNext, onCommitPrev } = setup();
      act(() => {
        hook.result.current.handleWheel(250, 0); // -250 drag units, past INSTANT_COMMIT_PX
      });
      expect(onCommitNext).toHaveBeenCalledTimes(1);
      expect(onCommitPrev).not.toHaveBeenCalled();
      expect(hook.result.current.dragPx).toBe(0);
    });

    it('swallows the coasting tail so one burst only moves one surface', () => {
      const { hook, onCommitNext } = setup();
      act(() => {
        hook.result.current.handleWheel(250, 0); // commits + enters coast
      });
      expect(onCommitNext).toHaveBeenCalledTimes(1);
      // Momentum tail of the SAME burst (tight timing) is consumed but cannot commit again.
      let consumed = false;
      act(() => {
        consumed = hook.result.current.handleWheel(40, 0);
      });
      expect(consumed).toBe(true);
      expect(onCommitNext).toHaveBeenCalledTimes(1);
    });

    it('springs a sub-threshold burst back to rest when the finger lifts (release detection)', () => {
      const { hook, onCommitNext, onCommitPrev } = setup();
      // A modest burst that peaks well below the 200px instant-commit trip and never clears the
      // 20% commit threshold (200px of a 1000px frame)...
      act(() => {
        hook.result.current.handleWheel(50, 0);
      });
      // ...then the per-event delta collapses below the burst's peak (the finger lifted) → the
      // release path settles the gesture WITHOUT committing.
      act(() => {
        hook.result.current.handleWheel(3, 0);
      });
      expect(onCommitNext).not.toHaveBeenCalled();
      expect(onCommitPrev).not.toHaveBeenCalled();
      expect(hook.result.current.dragPx).toBe(0);
    });

    it('clears the pending end-of-burst timer on unmount (no commit after teardown)', () => {
      const onCommitNext = vi.fn();
      const onCommitPrev = vi.fn();
      // Width 500 → commit threshold 100px but the hard-trip is still 200px, so a 120px burst is left
      // for the idle timer to settle (and it WOULD commit, since 120 ≥ 100) rather than committing now.
      const hook = renderHook((props: UseHorizontalSwipeOptions) => useHorizontalSwipe(props), {
        initialProps: {
          onCommitNext,
          onCommitPrev,
          canPrev: true,
          canNext: true,
          getWidth: () => 500,
        },
      });
      act(() => {
        hook.result.current.handleWheel(120, 0);
      });
      expect(onCommitNext).not.toHaveBeenCalled(); // still pending on the idle timer
      hook.unmount();
      act(() => {
        vi.runAllTimers();
      });
      // The unmount cleanup cleared the timer; without it the idle callback would settle → commit
      // against the torn-down consumer.
      expect(onCommitNext).not.toHaveBeenCalled();
      expect(onCommitPrev).not.toHaveBeenCalled();
    });
  });

  it('keeps stable handler identities across re-renders with fresh props', () => {
    const { hook } = setup();
    const first = hook.result.current;
    hook.rerender({ canPrev: false, canNext: false, getWidth: () => WIDTH });
    const second = hook.result.current;
    expect(second.onTouchStart).toBe(first.onTouchStart);
    expect(second.onTouchMove).toBe(first.onTouchMove);
    expect(second.onTouchEnd).toBe(first.onTouchEnd);
    expect(second.handleWheel).toBe(first.handleWheel);
  });
});
