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
  /** The conversation itself. Fills the card and scrolls internally. */
  transcript: ReactNode;
  /**
   * The input row, drawn beneath a hairline rule. `null` when this session has no composer — a
   * terminal status, or the read-only admin replay — in which case no rule is drawn either.
   */
  composer?: ReactNode;
  className?: string;
}

export function ConversationFrame({ transcript, composer, className }: ConversationFrameProps) {
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
      {transcript}
      {/* The seam AND the breathing room, both supplied here rather than by the composer: they are
          properties of stacking two things in one card, and a composer standing alone in a rail
          wants neither (padding there would inset it from the rail and drop its top and bottom out
          of line with the transcript beside it). Drawn on this wrapper, so a `null` composer —
          terminal session, read-only replay — leaves no rule and no empty band. */}
      {composer ? <div className="border-t px-4 py-3 sm:px-6 2xl:px-10">{composer}</div> : null}
    </div>
  );
}
