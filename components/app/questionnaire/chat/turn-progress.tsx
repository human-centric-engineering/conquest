'use client';

/**
 * TurnProgress — what the respondent watches while a turn is being worked out (P20 Phase 2).
 *
 * A turn runs four to six sequential model calls before the first token of the reply appears. The
 * surface used to show one static `Thinking…` across all of them, so a 5-second turn and a stuck
 * one were indistinguishable. This shows two things instead:
 *
 *   - **The stage the server says it is on** — "Reading your answer…", "Choosing what to ask
 *     next…". Every label is a claim about work that has genuinely started (see
 *     `lib/app/questionnaire/orchestrator/stage-progress.ts`), so none of them is theatre. Before
 *     the first `status` frame lands it falls back to the neutral opener.
 *   - **An elapsed clock, but only once the wait is long enough to need one.** Held back for
 *     {@link ELAPSED_AFTER_MS} so an ordinary fast turn stays calm and uncluttered; a slow one
 *     then gets the one reassurance that cannot be faked — proof the request is still alive.
 *
 * **Why this is not the platform's `ThinkingIndicator`.** That component is Sunrise's
 * (`components/admin/orchestration/chat/thinking-indicator.tsx`), and ConQuest extends the platform
 * through its seams rather than editing it — a prop added there would have to be re-applied on
 * every upstream sync. The dots are re-implemented here, deliberately, at the cost of a few lines.
 * The platform component is still used for the opening choreography's scripted beat in
 * `transcript-turns.tsx`, which is a ~1s pause and not a server wait at all: putting a running
 * clock on it would be nonsense.
 *
 * Accessibility: one `role="status"` region announces the label, and it alone. The dots and the
 * clock are `aria-hidden` — a screen reader being told a new number once a second is not
 * reassurance, it is a barrier.
 *
 * @see components/app/questionnaire/chat/current-exchange.tsx — the in-transcript wait
 * @see .context/app/questionnaire/turn-progress.md
 */

import { useEffect, useState } from 'react';

import { formatElapsed } from '@/lib/app/questionnaire/format-elapsed';
import { cn } from '@/lib/utils';

/**
 * How long a turn must run before the clock appears. Roughly the point at which a wait stops
 * reading as "instant" and starts reading as "is this working?" — most turns finish either side of
 * it, so the clock stays a signal rather than permanent furniture.
 */
export const ELAPSED_AFTER_MS = 4_000;

/** Shown until the first stage frame arrives — a beat or two on a fast turn. */
export const TURN_PROGRESS_FALLBACK = 'Thinking…';

export interface TurnProgressProps {
  /**
   * The live stage label from the stream, or null before the first `status` frame. Null renders
   * {@link TURN_PROGRESS_FALLBACK} rather than an empty row, so the indicator never collapses
   * mid-wait.
   */
  label?: string | null;
  /** Show the elapsed clock once the wait passes {@link ELAPSED_AFTER_MS}. Default true. */
  showElapsed?: boolean;
  className?: string;
}

export function TurnProgress({ label, showElapsed = true, className }: TurnProgressProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // One interval for the life of the wait. The component is mounted only while a turn is in
  // flight, so unmount is the stop condition and the count always starts from this turn's zero.
  useEffect(() => {
    if (!showElapsed) return;
    const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1_000);
    return () => clearInterval(timer);
  }, [showElapsed]);

  const text = label && label.trim().length > 0 ? label : TURN_PROGRESS_FALLBACK;
  const clockVisible = showElapsed && elapsedSeconds * 1_000 >= ELAPSED_AFTER_MS;

  return (
    <div
      className={cn('flex items-center gap-1.5 text-sm', className)}
      role="status"
      aria-label={text}
    >
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0s]" />
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0.15s]" />
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0.3s]" />
      </span>
      <span className="text-muted-foreground text-xs italic">{text}</span>
      {clockVisible && (
        <span
          aria-hidden="true"
          data-testid="turn-elapsed"
          className="text-muted-foreground text-xs tabular-nums opacity-70"
        >
          {formatElapsed(elapsedSeconds)}
        </span>
      )}
    </div>
  );
}
