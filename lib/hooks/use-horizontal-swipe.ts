'use client';

/**
 * useHorizontalSwipe — drive a horizontal carousel with a live, follow-the-gesture drag.
 *
 * Unlike a fire-once swipe detector, this reports a continuous `dragPx` so the track can move
 * WITH the gesture: a small nudge slides the surface a little and springs back (signalling "this
 * is swipeable"), while a fuller gesture crosses the commit threshold and changes surface. It
 * covers the two desktop/mobile inputs that carry a horizontal gesture:
 *   - touch drag (phones/tablets)             → onTouch* handlers, tracks the finger 1:1
 *   - trackpad / Magic Mouse horizontal swipe → handleWheel, accumulates the `deltaX` burst
 *
 * A trackpad swipe is a momentum burst with no release event, so the wheel path accumulates the
 * travel, follows it live, and decides commit-vs-spring-back when the finger lifts (detected via the
 * delta collapsing from the burst's peak). `handleWheel` returns `true` when it consumed a horizontal
 * gesture, so the caller can `preventDefault` to stop the browser's own two-finger history nav.
 *
 * The returned handlers keep a STABLE identity across renders (latest props are read through a ref),
 * so a consumer can bind `handleWheel` to a native listener once instead of re-binding every render.
 *
 * Resistance: dragging toward an edge with no neighbour is damped to a short rubber-band so the end
 * of the carousel feels like a wall, not a dead surface. Keyboard arrows are the consumer's job.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const COMMIT_RATIO = 0.2; // travel past 20% of the frame width commits the surface change
const INSTANT_COMMIT_PX = 200; // a wheel burst this far in one direction commits instantly, mid-gesture
const EDGE_DAMP = 0.3; // resistance factor when pulling past the first/last surface
const EDGE_MAX_RATIO = 0.12; // hard cap on the rubber-band at an edge
const WHEEL_IDLE_MS = 200; // fallback: a wheel burst that just stops is "done" after this gap
const WHEEL_RELEASE_FRACTION = 0.35; // a delta this far below the burst's peak means the finger lifted
const WHEEL_RELEASE_FLOOR = 6; // …and is also this small in absolute terms (px) — i.e. momentum nearly spent
const WHEEL_NEW_GESTURE_GAP_MS = 80; // a pause longer than this between wheel events starts a fresh swipe
const FALLBACK_WIDTH = 320; // before the frame is measured

export interface HorizontalSwipeState {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  /** Feed raw wheel deltas; returns true when it consumed a horizontal gesture (→ preventDefault). */
  handleWheel: (deltaX: number, deltaY: number) => boolean;
  /** Live horizontal offset (px) to add to the whole track. 0 at rest. */
  dragPx: number;
  /** Whether the track should animate right now (true while settling, false while following). */
  animating: boolean;
}

export interface UseHorizontalSwipeOptions {
  /** Commit forward — the gesture revealed the next (right-hand) surface. */
  onCommitNext?: () => void;
  /** Commit backward — the gesture revealed the previous (left-hand) surface. */
  onCommitPrev?: () => void;
  /** Is there a previous surface to drag toward? Gates the back direction (else rubber-bands). */
  canPrev?: boolean;
  /** Is there a next surface to drag toward? Gates the forward direction (else rubber-bands). */
  canNext?: boolean;
  /** Current frame width (px), used for the commit threshold and clamping. */
  getWidth?: () => number;
}

export function useHorizontalSwipe(options: UseHorizontalSwipeOptions): HorizontalSwipeState {
  const [dragPx, setDragPx] = useState(0);
  const [animating, setAnimating] = useState(false);

  // Read the latest props through a ref so every handler below can have a STABLE identity (empty
  // dep arrays). Without this, inline `onCommit*` callbacks recreated each render would churn the
  // handler identities and force a consumer's native listener to re-bind on every render. The
  // handlers only read this inside user-driven events, which always run after the commit effect.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const width = useCallback(() => latest.current.getWidth?.() || FALLBACK_WIDTH, []);

  // Positive drag = track moves right = the PREVIOUS surface slides in (a "go back" gesture).
  // Negative drag = the NEXT surface slides in. Damp + clamp so an edge feels like a wall and a
  // mid-carousel drag never exposes more than one surface.
  const clamp = useCallback(
    (raw: number) => {
      const { canPrev, canNext } = latest.current;
      const w = width();
      if (raw > 0) {
        return canPrev ? Math.min(raw, w) : Math.min(raw * EDGE_DAMP, w * EDGE_MAX_RATIO);
      }
      if (raw < 0) {
        return canNext ? Math.max(raw, -w) : Math.max(raw * EDGE_DAMP, -w * EDGE_MAX_RATIO);
      }
      return 0;
    },
    [width]
  );

  // Resolve a finished gesture: commit if it cleared the threshold in an allowed direction, then
  // spring the track back to rest (the commit shifts the base offset, so 0 lands on the new surface).
  // `force` skips the ratio test — used by the hard 200px wheel trip, which has already decided.
  const settle = useCallback(
    (travel: number, force = false) => {
      const { canPrev, canNext, onCommitNext, onCommitPrev } = latest.current;
      const commit = width() * COMMIT_RATIO;
      setAnimating(true);
      setDragPx(0);
      const goNext = force ? travel < 0 : travel <= -commit;
      const goPrev = force ? travel > 0 : travel >= commit;
      if (goNext && canNext) onCommitNext?.();
      else if (goPrev && canPrev) onCommitPrev?.();
    },
    [width]
  );

  // ── Touch — track the finger 1:1 ─────────────────────────────────────────────────────────
  const start = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      start.current = null; // multi-touch (pinch/zoom) is never a swipe
      return;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    horizontal.current = false;
    setAnimating(false);
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!start.current) return;
      const t = e.touches[0];
      const dx = t.clientX - start.current.x;
      const dy = t.clientY - start.current.y;
      if (!horizontal.current) {
        // Decide the dominant axis once; a vertical-dominant move hands the gesture back to scroll.
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          if (Math.abs(dx) > Math.abs(dy)) horizontal.current = true;
          else {
            start.current = null;
            return;
          }
        } else {
          return;
        }
      }
      setDragPx(clamp(dx));
    },
    [clamp]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const origin = start.current;
      const wasHorizontal = horizontal.current;
      start.current = null;
      horizontal.current = false;
      if (!origin || !wasHorizontal) return;
      const t = e.changedTouches[0];
      settle(t ? t.clientX - origin.x : 0);
    },
    [settle]
  );

  // ── Wheel — follow the burst, decide the moment the finger lifts ──────────────────────────
  // A trackpad swipe is one burst whose per-event delta spikes while the finger drives it, then
  // decays as momentum coasts. We follow it live and decide as early as we can:
  //   • cross the hard 200px trip → commit instantly, mid-gesture;
  //   • otherwise watch for the delta to collapse below the burst's peak (the finger lifted) and
  //     decide THEN — commit if past the ratio, else spring back.
  // After a decision we `coast` — swallowing the rest of THIS burst (the still-driving tail of a hard
  // push, then its momentum) so one physical swipe can only ever move one surface. The reliable
  // "this is a different swipe" signal is timing, not magnitude: within one swipe the wheel streams
  // continuously (~16ms between events), whereas a new swipe follows a lift-and-reposition pause. So
  // a gap longer than WHEEL_NEW_GESTURE_GAP_MS — not a delta that happens to rise — is what starts fresh.
  const wheelAcc = useRef(0);
  const wheelPeak = useRef(0);
  const wheelCoasting = useRef(false);
  const wheelLastTime = useRef(0);
  const wheelIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finishWheel = useCallback(
    (force: boolean) => {
      wheelCoasting.current = true;
      const travel = wheelAcc.current;
      wheelAcc.current = 0;
      wheelPeak.current = 0;
      settle(travel, force);
    },
    [settle]
  );

  const handleWheel = useCallback(
    (deltaX: number, deltaY: number) => {
      // Vertical-dominant wheel is a scroll — don't touch it, and let it through (no preventDefault).
      if (Math.abs(deltaX) <= Math.abs(deltaY)) return false;
      const adx = Math.abs(deltaX);

      // A long-enough pause since the last event means the previous burst is over and this is a
      // brand-new swipe — reset and act on it. This (not magnitude) is what frees a coasting burst.
      const now = performance.now();
      const gap = now - wheelLastTime.current;
      wheelLastTime.current = now;
      if (gap > WHEEL_NEW_GESTURE_GAP_MS) {
        wheelCoasting.current = false;
        wheelAcc.current = 0;
        wheelPeak.current = 0;
      }

      // Refresh the end-of-burst fallback: when the wheel truly stops, settle a pending drag and reset.
      if (wheelIdle.current) clearTimeout(wheelIdle.current);
      wheelIdle.current = setTimeout(() => {
        if (!wheelCoasting.current && wheelAcc.current !== 0) settle(wheelAcc.current);
        wheelCoasting.current = false;
        wheelAcc.current = 0;
        wheelPeak.current = 0;
      }, WHEEL_IDLE_MS);

      // Already decided this burst — swallow its driving tail + momentum so it can't move a 2nd surface.
      if (wheelCoasting.current) return true;

      wheelAcc.current += -deltaX; // → drag units (right-swipe deltaX is negative on natural scroll)
      wheelPeak.current = Math.max(wheelPeak.current, adx);
      setAnimating(false);
      setDragPx(clamp(wheelAcc.current));

      // Hard trip: a decisive push commits instantly, without waiting for release.
      if (Math.abs(wheelAcc.current) >= INSTANT_COMMIT_PX) {
        finishWheel(true);
        return true;
      }
      // Release: the delta has collapsed well below the burst's peak → the finger lifted. Decide now.
      if (adx < wheelPeak.current * WHEEL_RELEASE_FRACTION && adx < WHEEL_RELEASE_FLOOR) {
        finishWheel(false);
        return true;
      }
      return true; // consumed a horizontal gesture — caller suppresses native history nav
    },
    [clamp, finishWheel, settle]
  );

  return { onTouchStart, onTouchMove, onTouchEnd, handleWheel, dragPx, animating };
}
