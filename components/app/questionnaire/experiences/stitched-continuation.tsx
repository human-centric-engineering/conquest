'use client';

/**
 * The seam, under `stitched` continuity (P15.3).
 *
 * Where `HandoffCard` presents a card and waits for a tap, this presents the wait as a turn still
 * being composed and then continues on its own. That difference is the entire user-visible payload
 * of `stitched`: the author asked for one continuous conversation, and a button in the middle of
 * it is the seam they were trying to remove.
 *
 * ## Why auto-navigating is safe here and not in `linked`
 *
 * The objection to moving someone without their agreement is real, and it is why `linked` refuses
 * to. It does not apply here for two reasons. The respondent has not finished and been redirected
 * into something new — from their side the interviewer simply carried on, which is what they were
 * told would happen. And the author made this choice explicitly per experience; it is not a
 * default anyone backs into.
 *
 * The escape hatch still exists: the browser Back button returns to the completed leg, and the
 * transcript above the new questions is their own.
 *
 * A `conclude` or `failed` outcome does NOT auto-navigate — those are endings, and an ending
 * deserves to be read rather than skipped past. The parent renders its own terminal state for
 * both.
 */

import { useEffect, useRef } from 'react';

import { useRunHandoff } from '@/lib/hooks/use-run-handoff';
import type { RunPollState } from '@/lib/app/questionnaire/experiences/run/types';

export interface StitchedContinuationProps {
  runId: string;
  /** The leg just completed. */
  sessionId: string;
  /** Signed token for the no-login surface; omitted on the authenticated one. */
  sessionToken?: string;
  /**
   * Move the respondent into the next leg. A callback rather than an href because the two surfaces
   * continue differently — the authenticated one navigates to the new session's URL, while
   * `/x/<publicRef>` is already the right address and must refresh in place.
   */
  onContinue: (sessionId: string, sessionToken?: string) => void;
  /**
   * Called when the run ends rather than continuing, so the parent can render the completion
   * screen. Also called on a failed handoff — both are terminal for this component.
   */
  onSettled: (state: RunPollState) => void;
}

export function StitchedContinuation({
  runId,
  sessionId,
  sessionToken,
  onContinue,
  onSettled,
}: StitchedContinuationProps) {
  const state = useRunHandoff({ runId, sessionId, sessionToken });
  // A resolved poll must act exactly once. Without this, any re-render between the router.push and
  // the actual navigation (the parent re-rendering on its own state, Strict Mode's double effect)
  // fires a second push at the same leg.
  const acted = useRef(false);

  useEffect(() => {
    if (acted.current || state.state === 'pending') return;

    if (state.state === 'leg') {
      acted.current = true;
      onContinue(state.sessionId, state.sessionToken);
      return;
    }

    acted.current = true;
    onSettled(state);
  }, [state, onContinue, onSettled]);

  // The wait, rendered as a turn being composed rather than as a card. Deliberately wordless: any
  // copy here ("working out what's next…") would announce the seam that `stitched` exists to hide.
  return (
    <div
      className="flex items-center gap-1.5 px-1 py-3"
      role="status"
      aria-label="Composing the next question"
    >
      <span className="bg-muted-foreground/50 h-2 w-2 animate-bounce rounded-full [animation-delay:-0.3s]" />
      <span className="bg-muted-foreground/50 h-2 w-2 animate-bounce rounded-full [animation-delay:-0.15s]" />
      <span className="bg-muted-foreground/50 h-2 w-2 animate-bounce rounded-full" />
    </div>
  );
}
