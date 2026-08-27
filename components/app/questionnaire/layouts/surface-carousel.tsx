'use client';

/**
 * The surface carousel — the sliding track every layout so far puts the respondent's surfaces on.
 *
 * Intro, details, interviewer, conversation and form ride left-to-right; the toggle, the arrow keys
 * and a finger drag all move between them. That is not layout-specific: a layout decides what each
 * surface *looks* like, not how sliding between them works.
 *
 * Extracted at the third layout rather than the second, deliberately. Two copies of a block this
 * subtle are watchable; three is where one of them quietly loses the `overflow-clip` and a stray
 * `scrollIntoView` starts dragging the whole track sideways. Every comment below is load-bearing
 * and each one records a bug that has actually happened here.
 *
 * A layout still owns everything visible: it passes `surfaceFor`, which returns its own arrangement
 * for a given surface. This owns only the track.
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { VIEW_META } from '@/components/app/questionnaire/layouts/view-meta';
import type { SessionWorkspaceState, WorkspaceView } from '@/lib/hooks/use-session-workspace';

export interface SurfaceCarouselProps {
  /** The live workspace — the present surfaces, the active one, and the drag state. */
  state: SessionWorkspaceState;
  /** The layout's own arrangement for one surface. */
  surfaceFor: (view: WorkspaceView) => ReactNode;
}

export function SurfaceCarousel({ state, surfaceFor }: SurfaceCarouselProps) {
  const { views, activeView, activeIndex, swipe, carouselRef } = state;

  // One surface: no track, no gesture handling, no absolutely-positioned cells — just the surface.
  if (views.length <= 1) {
    return <div className="min-h-0 flex-1">{surfaceFor(views[0] ?? 'chat')}</div>;
  }

  return (
    // Each surface is an absolutely-positioned cell pinned to the clipped frame (`absolute inset-0`
    // → exactly one frame wide, no flex/percentage width maths to misfire), slid horizontally by its
    // distance from the active surface. The active cell sits at 0; the rest are parked one (or more)
    // frame-widths to the left/right and clipped away. Sliding the toggle re-computes every offset,
    // so the whole set animates as one track.
    //
    // `overflow-clip`, NOT `overflow-hidden`: `hidden` leaves the frame programmatically scrollable,
    // so when an off-screen cell's content grabs focus or calls `scrollIntoView` (the chat composer
    // autofocus, the message auto-scroll), the browser scrolls the frame sideways to "reveal" it and
    // drags the whole carousel off-screen. `clip` clips identically but establishes no scroll
    // container, so nothing can shift it.
    <div
      ref={carouselRef}
      className="relative min-h-0 flex-1 overflow-clip"
      style={{ overscrollBehaviorX: 'contain' }}
      onTouchStart={swipe.onTouchStart}
      onTouchMove={swipe.onTouchMove}
      onTouchEnd={swipe.onTouchEnd}
    >
      {views.map((view, i) => {
        const offset = (i - activeIndex) * 100;
        return (
          <div
            key={view}
            role="tabpanel"
            aria-label={VIEW_META[view].label}
            className={cn(
              'absolute inset-0 overflow-clip will-change-transform motion-reduce:transition-none',
              // Animate every settled move (toggle, arrow keys, gesture release) — i.e. whenever the
              // track is at rest (`dragPx === 0`) or actively springing back (`animating`). Only an
              // in-progress finger/wheel drag (non-zero `dragPx`, not yet settled) skips the
              // transition so the surface tracks the gesture 1:1.
              (swipe.animating || swipe.dragPx === 0) &&
                'transition-transform duration-300 ease-out'
            )}
            style={{ transform: `translateX(calc(${offset}% + ${swipe.dragPx}px))` }}
            inert={activeView !== view}
          >
            {surfaceFor(view)}
          </div>
        );
      })}
    </div>
  );
}
