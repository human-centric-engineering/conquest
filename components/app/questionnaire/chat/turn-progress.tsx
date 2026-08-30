'use client';

/**
 * TurnProgress — what the respondent watches while a turn is being worked out (P20 Phase 2).
 *
 * A turn runs four to six sequential model calls before the first token of the reply appears. The
 * surface used to show one static `Thinking…` across all of them, so a 5-second turn and a stuck
 * one were indistinguishable. This shows three things instead:
 *
 *   - **The stage the server says it is on** — "Reading your answer…", "Choosing what to ask
 *     next…". Every label is a claim about work that has genuinely started (see
 *     `lib/app/questionnaire/orchestrator/stage-progress.ts`), so none of them is theatre. Before
 *     the first `status` frame lands it falls back to the neutral opener.
 *   - **An elapsed clock, but only once the wait is long enough to need one.** Held back for
 *     {@link ELAPSED_AFTER_MS} so an ordinary fast turn stays calm and uncluttered; a slow one
 *     then gets the one reassurance that cannot be faked — proof the request is still alive.
 *
 * **One row, and one thing moving.** A stage swapped in place is motion the respondent registers
 * and cannot read, so a label fades OUT, is replaced, and fades back IN — never both at once, and
 * never with a slide. An earlier build kept the outgoing line above the live one and scrolled it
 * away; that was too much happening at once, and the taller box also broke the turn's alignment
 * with the interviewer's mark (`AssistantTurn` pins its dot to the FIRST line of the turn, so a
 * two-row indicator left the dot floating a row above the words).
 *
 * What actually makes a fast sequence readable is the dwell, not the animation: `usePacedStageLabel`
 * in `ConversationProvider` holds each label long enough to read and queues the rest. The fade here
 * only softens the change it schedules.
 *
 * **Why this is not the platform's `ThinkingIndicator`.** That component is Sunrise's
 * (`components/admin/orchestration/chat/thinking-indicator.tsx`), and ConQuest extends the platform
 * through its seams rather than editing it — a prop added there would have to be re-applied on
 * every upstream sync. The dots are re-implemented here, deliberately, at the cost of a few lines.
 * The platform component is still used for the opening choreography's scripted beat in
 * `transcript-turns.tsx`, which is a ~1s pause and not a server wait at all: putting a running
 * clock on it would be nonsense.
 *
 * Accessibility: one `role="status"` region announces the live label, and it alone. The dots and
 * the clock are `aria-hidden` — a screen reader being told a new number once a second is not
 * reassurance, it is a barrier. Reduced motion swaps the words with no fade at all, rather than
 * fading over zero milliseconds.
 *
 * @see components/app/questionnaire/chat/current-exchange.tsx — the in-transcript wait
 * @see .context/app/questionnaire/turn-progress.md
 */

import { useEffect, useState } from 'react';

import { formatElapsed } from '@/lib/app/questionnaire/format-elapsed';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

/**
 * How long a turn must run before the clock appears. Roughly the point at which a wait stops
 * reading as "instant" and starts reading as "is this working?" — most turns finish either side of
 * it, so the clock stays a signal rather than permanent furniture.
 */
export const ELAPSED_AFTER_MS = 4_000;

/** Shown until the first stage frame arrives — a beat or two on a fast turn. */
export const TURN_PROGRESS_FALLBACK = 'Thinking…';

/**
 * Half of a hand-off: how long the outgoing label takes to fade out, and then the incoming one to
 * fade in. Short enough that the whole change costs a third of a dwell, long enough that the eye
 * reads it as a change of subject rather than a glitch.
 */
export const LABEL_FADE_MS = 180;

export interface TurnProgressProps {
  /**
   * The live stage label from the stream, or null before the first `status` frame. Null renders
   * {@link TURN_PROGRESS_FALLBACK} rather than an empty row, so the indicator never collapses
   * mid-wait.
   *
   * Expected to arrive already paced (`usePacedStageLabel`, in `ConversationProvider`). This
   * component decides how a change LOOKS; it does not decide when one happens.
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
  const reducedMotion = usePrefersReducedMotion();

  // The words currently painted, and whether they are on their way out. The prop changes at the
  // moment the stage does; `shown` lags it by one fade so the old label is gone before the new one
  // arrives. Two labels cross-fading over each other in one row is a smear, not a hand-off.
  const [shown, setShown] = useState(text);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    if (text === shown) return;
    if (reducedMotion) {
      setShown(text);
      return;
    }
    setFadingOut(true);
    const timer = setTimeout(() => {
      setShown(text);
      setFadingOut(false);
    }, LABEL_FADE_MS);
    return () => clearTimeout(timer);
  }, [text, shown, reducedMotion]);

  const clockVisible = showElapsed && elapsedSeconds * 1_000 >= ELAPSED_AFTER_MS;

  return (
    <div
      /* `min-h-6` keeps the row a constant height whatever the label is doing, so the turn's
         accent mark — which `AssistantTurn` pins to the first line — stays level with the words. */
      className={cn('flex min-h-6 items-center gap-1.5 text-sm', className)}
      role="status"
      aria-label={shown}
    >
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0s]" />
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0.15s]" />
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0.3s]" />
      </span>
      {/* Only the words change. The dots and the clock hold still through a hand-off — furniture
          that moves for a change it had no part in is the fidget this is meant to avoid. */}
      <span
        data-testid="turn-progress-label"
        className={cn(
          'text-muted-foreground min-w-0 truncate text-xs italic transition-opacity',
          fadingOut ? 'opacity-0' : 'opacity-100'
        )}
        style={{ transitionDuration: `${LABEL_FADE_MS}ms` }}
      >
        {shown}
      </span>
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
