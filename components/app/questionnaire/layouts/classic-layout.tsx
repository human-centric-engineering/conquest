'use client';

/**
 * ConQuest Classic — the arrangement the respondent surface has always had, and the default
 * everywhere.
 *
 * A lifecycle strip across the top, then a carousel of surfaces: the pre-conversation gates
 * (intro, details, interviewer) followed by the conversation and the form. The conversation
 * surface is itself a split — transcript on the left, live answer panel on the right from `lg`
 * up, with the panel's mobile twin (a bottom sheet) standing in below that.
 *
 * This file is a faithful extraction, not a redesign: it is the JSX that used to live inside
 * `SessionWorkspace`, moved behind the layout contract with no behavioural change. Anything that
 * looks odd here is load-bearing and the comment beside it says why — `overflow-clip` rather than
 * `overflow-hidden`, the absolutely-positioned carousel cells, the `h-full` that only applies when
 * the panel is hidden.
 *
 * Reads nothing and fetches nothing: every part arrives already built in `slots`, and every
 * decision it needs has already been made on `state`.
 */

import { cn } from '@/lib/utils';
import { RESPONDENT_SPLIT } from '@/lib/app/questionnaire/layout';
import { VIEW_META } from '@/components/app/questionnaire/layouts/view-meta';
import type { RespondentLayoutProps } from '@/components/app/questionnaire/layouts/types';

export function ClassicLayout({ slots, state }: RespondentLayoutProps) {
  const { showPanel, showForm, views, activeView, activeIndex, swipe, carouselRef } = state;

  // The conversation column: the submit/finish affordance above the transcript. Takes the full
  // height only when there is no panel beside it — with a panel, the grid track governs.
  const chatColumn = (
    <div className={cn('flex min-h-0 flex-col gap-3', !showPanel && 'h-full')}>
      {slots.completionOffer}
      {slots.conversation}
    </div>
  );

  const chatSurface = showPanel ? (
    // The conversation ⇄ panel split. Track widths ladder up with the viewport (see
    // RESPONDENT_SPLIT) so a large display gives the panel real room instead of pouring every
    // extra pixel into the transcript's line length.
    <div className={cn('grid h-full min-h-0', RESPONDENT_SPLIT)}>
      {chatColumn}
      {slots.answersPanel}
    </div>
  ) : (
    // Chat-only: no split at all, so the conversation gets the shell's full width at every
    // breakpoint rather than an empty panel track beside it.
    chatColumn
  );

  const formSurface = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {slots.completionOffer}
      {slots.formView}
    </div>
  );

  const surfaceFor = (view: (typeof views)[number]) => {
    switch (view) {
      case 'intro':
        return slots.splash;
      case 'capture':
        return slots.captureGate;
      case 'persona':
        return slots.personaPicker;
      case 'form':
        return formSurface;
      default:
        return chatSurface;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {slots.finalCheck}
      {slots.personaSwitcher}
      {slots.lifecycleBar}
      {slots.answersDrawer}

      {views.length > 1 ? (
        // Carousel: each surface is an absolutely-positioned cell pinned to the clipped frame
        // (`absolute inset-0` → exactly one frame wide, no flex/percentage width maths to misfire),
        // slid horizontally by its distance from the active surface. The active cell sits at 0; the
        // rest are parked one (or more) frame-widths to the left/right and clipped away. Sliding the
        // toggle re-computes every offset, so the whole set animates as one track.
        //
        // `overflow-clip`, NOT `overflow-hidden`: `hidden` leaves the frame programmatically
        // scrollable, so when an off-screen cell's content grabs focus or calls `scrollIntoView`
        // (the chat composer autofocus, the message auto-scroll), the browser scrolls the frame
        // sideways to "reveal" it and drags the whole carousel off-screen. `clip` clips identically
        // but establishes no scroll container, so nothing can shift it.
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
      ) : (
        <div className="min-h-0 flex-1">{showForm ? formSurface : chatSurface}</div>
      )}
    </div>
  );
}
