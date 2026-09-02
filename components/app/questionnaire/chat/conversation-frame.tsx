'use client';

/**
 * ConversationFrame — the transcript and the composer stacked in one card.
 *
 * The arrangement `conversation` used to be, back when it was a single slot: a bordered card, the
 * transcript filling it, the composer along the bottom behind a hairline rule. Classic and Focus
 * both want exactly that, and the read-only admin replay wants the same card with no composer at
 * all — so it is declared once here rather than three times.
 *
 * Two things it is deliberately NOT:
 *
 *   - It is not a feature. It builds nothing, fetches nothing and decides nothing; it takes two
 *     ready-made nodes and puts them one above the other. That is why a layout may use it without
 *     breaking the rule that layouts arrange rather than construct — it is arrangement, shared.
 *   - It is not mandatory. A layout that wants the composer somewhere else (Broadsheet puts it in
 *     the margin) places `slots.transcript` and `slots.composer` itself and never touches this.
 *
 * It also draws the two bands the card can carry — a `header` above the transcript and a `footer`
 * below the composer — for the controls that act ON the conversation rather than being part of it.
 * Both collapse to nothing, rule included, when what they hold draws nothing.
 *
 * The seam and the padding around the composer both live here, not on the composer, because both
 * belong to the arrangement rather than to the thing arranged: a `border-t` and a band of
 * breathing room are right when the two are stacked in one card, and wrong when the composer
 * stands alone in a rail — there they inset it from the rail's edges and drop its top and bottom
 * out of line with the transcript beside it. Drawn on a wrapper rather than passed down as classes
 * so that a `null` composer — a terminal session, or the read-only viewer — leaves neither a stray
 * rule under the transcript nor an empty band below it.
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface ConversationFrameProps {
  /**
   * The card's own chrome band, drawn above the transcript behind a hairline rule: the controls
   * that act on the conversation rather than being part of it (the section strip, the submit
   * offer).
   *
   * Inside the card rather than above it because a stack of bands above the card pushes its top
   * edge down, and on Classic that edge is aligned with the answers panel beside it. A band that
   * comes and goes would then move the whole conversation up and down the page relative to its
   * neighbour.
   *
   * It disappears completely, rule included, when everything inside it renders nothing — which is
   * the usual case, since most questionnaires are unsectioned and the submit offer only ever
   * appears near the end. That is `empty:hidden` on the wrapper rather than a prop, because the
   * frame is handed ready-made nodes and cannot ask them whether they intend to draw anything.
   */
  header?: ReactNode;
  /** The conversation itself. Fills the card and scrolls internally. */
  transcript: ReactNode;
  /**
   * The input row, drawn beneath a hairline rule. `null` when this session has no composer — a
   * terminal status, or the read-only admin replay — in which case no rule is drawn either.
   */
  composer?: ReactNode;
  /**
   * The card's closing band, beneath the composer behind a second hairline: the controls that act
   * on the conversation from below (the section's "move on").
   *
   * The `header`'s twin, and there for the same reason. A control on a row under the card pushed
   * the card's bottom edge up, and on Classic that edge is aligned with the foot of the answers
   * panel beside it — so the moment a section became finishable, the two columns stopped ending
   * level. Disappears with its rule when what it holds draws nothing, which is most turns: the
   * close control is silent until the section is either finishable or stuck.
   */
  footer?: ReactNode;
  className?: string;
}

export function ConversationFrame({
  header,
  transcript,
  composer,
  footer,
  className,
}: ConversationFrameProps) {
  return (
    <div
      // `cq-conversation-frame` is a handle for the design axis, not a style: `marque` turns this
      // card's left hairline into an accent spine, so the conversation reads as a bound document.
      // A class rather than a prop because a design is CSS and this component has no business
      // knowing which one is active.
      className={cn(
        'cq-conversation-frame bg-card flex h-full min-h-0 flex-col rounded-xl border',
        className
      )}
    >
      {/* `empty:hidden` collapses the band, its padding and its rule together when nothing inside
          it draws — an unsectioned interview with no offer yet, which is most of a session. The
          children must therefore be the nodes themselves, with no always-present wrapper between:
          one stray `<div>` in here and `:empty` never matches again. */}
      {header ? (
        <div
          // A handle for the test that asserts this wrapper stays childless when its slots draw
          // nothing — the `:empty` rule above is the whole mechanism, and one stray element in here
          // would silently leave an empty band and its rule on screen forever.
          data-testid="conversation-header"
          className="flex flex-col gap-2 rounded-t-xl border-b px-3 py-2 empty:hidden sm:px-4"
        >
          {header}
        </div>
      ) : null}
      {transcript}
      {/* The seam AND the breathing room, both supplied here rather than by the composer: they are
          properties of stacking two things in one card, and a composer standing alone in a rail
          wants neither (padding there would inset it from the rail and drop its top and bottom out
          of line with the transcript beside it). Drawn on this wrapper, so a `null` composer —
          terminal session, read-only replay — leaves no rule and no empty band. */}
      {composer ? <div className="border-t px-4 py-3 sm:px-6 2xl:px-10">{composer}</div> : null}
      {/* Same `empty:hidden` contract as the header band, and the same warning: nothing may sit
          between this wrapper and the slots, or `:empty` stops matching and every conversation
          carries an empty band and a rule at its foot for good. */}
      {footer ? (
        <div
          data-testid="conversation-footer"
          className="flex flex-wrap items-center gap-2 rounded-b-xl border-t px-3 py-2 empty:hidden sm:px-4"
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
