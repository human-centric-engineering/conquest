'use client';

/**
 * The state the transcript and the composer share once a layout is allowed to place them apart.
 *
 * They used to be one component, so this was just two `useState`s in a closure. Splitting
 * `conversation` into the `transcript` and `composer` slots means a layout may put the composer in
 * a margin, a rail, or a docked bar — anywhere in its own tree — and the two halves then have no
 * common ancestor to share state through except a provider the CONTAINER mounts above the whole
 * layout. That is exactly what this is, and it is mounted in one place
 * (`SessionWorkspace`) for the same reason `--cq-chat-scale` is: so no layout has to remember it.
 *
 * Deliberately minimal. Only what genuinely cannot be derived twice lives here:
 *
 *   - **The reveal queue** (`revealCursor`). Assistant turns type in strictly one at a time; the
 *     transcript owns that clock, but the composer is gated on it, and re-deriving "has the reply
 *     finished revealing" from `turns` alone is impossible — the cursor IS the state.
 *   - **`composerReady`**, the gate that clock feeds. Both halves read it: the composer to stay
 *     shut, the transcript to hold back the question card and the correction strip. Two
 *     definitions of "ready" would let a respondent answer a question they had not finished
 *     reading, which is the bug this gate exists to prevent.
 *   - **`isTerminal`** and the wait cue, so a terminal session cannot end up with one half
 *     believing the conversation is over and the other still offering input.
 *
 * Everything else stays a prop. `glossary`, the reasoning placement, `correctionTargets` and the
 * stitched history belong to the transcript alone; the voice and attachment flags belong to the
 * composer alone. Pushing them through here would make the context a second, competing props
 * channel and cost the type-checking that catches a missing one.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { isTerminalStatus } from '@/lib/app/questionnaire/chat/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';

export interface ConversationContextValue {
  /**
   * The index of the assistant turn currently being revealed. Turns before it have settled, the
   * turn at it is active (beat → type), turns after it stay hidden until the queue reaches them.
   */
  revealCursor: number;
  /**
   * Advance past the turn at `index`, once it has finished typing in. Monotonic (`max`) so a
   * late `onDone` from an earlier turn cannot rewind the queue.
   */
  advanceReveal: (index: number) => void;
  /** How many turns were already on screen at mount — a resumed transcript's settled history. */
  openingTurnCount: number;
  /** Type the seeded opening turns in rather than snapping them in. Fresh sessions only. */
  animateOpening: boolean;
  /**
   * Both clocks have settled: the HTTP stream has closed AND the reveal queue has caught up to the
   * last committed turn. The composer opens, and the transcript's answer affordances appear.
   *
   * Gating on `canSend` alone re-opened the box mid-reveal, letting a respondent answer a question
   * they had not finished reading — or, during the opening burst, one still entirely hidden.
   */
  composerReady: boolean;
  /** No further input is meaningful — the session is capped, paused, submitted or expired. */
  isTerminal: boolean;
  /** Why the composer is held shut, when it is held shut for a non-terminal reason. */
  composerHint: string;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export interface ConversationProviderProps {
  /** The shared stream state, owned by `SessionWorkspace`. */
  stream: UseQuestionnaireSessionStreamReturn;
  /**
   * Type the seeded opening turn(s) in instead of snapping them in fully-formed. Set for fresh
   * sessions; leave off on resume so a restored transcript renders its history instantly.
   */
  animateOpening?: boolean;
  children: ReactNode;
}

export function ConversationProvider({
  stream,
  animateOpening = false,
  children,
}: ConversationProviderProps) {
  const { turns, streaming, status, canSend } = stream;

  // The seeded turns present at mount. On a resumed session (`animateOpening` off) these render
  // instantly and the queue begins just past them.
  const [openingTurnCount] = useState(() => turns.length);
  const [revealCursor, setRevealCursor] = useState(() => (animateOpening ? 0 : turns.length));

  // The cursor only ever rests on an assistant turn (the one being typed). A user turn at the
  // cursor is the respondent's own message — already on screen — so step straight over it.
  useEffect(() => {
    if (turns[revealCursor]?.role === 'user') setRevealCursor((c) => c + 1);
  }, [revealCursor, turns]);

  // The HTTP stream closes the instant a reply commits, but the typewriter keeps running after
  // that — and on the opening burst the next question can still be fully hidden. Both clocks have
  // to settle before any input affordance opens.
  const revealPending = revealCursor < turns.length;

  const value: ConversationContextValue = {
    revealCursor,
    advanceReveal: (index) => setRevealCursor((c) => Math.max(c, index + 1)),
    openingTurnCount,
    animateOpening,
    composerReady: canSend && !revealPending,
    isTerminal: isTerminalStatus(status),
    composerHint: streaming ? 'Waiting for a reply…' : 'Revealing the reply…',
  };

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

/**
 * Read the shared conversation state.
 *
 * Throws rather than returning a default when no provider is above: a composer that silently
 * decided it was "ready" because it could not find the reveal queue would open mid-reveal, which
 * is precisely the failure the queue exists to prevent. A missing provider is a wiring bug in a
 * layout host, and it should surface in development rather than as a subtle timing fault.
 */
export function useConversation(): ConversationContextValue {
  const value = useContext(ConversationContext);
  if (!value) {
    throw new Error('useConversation must be used within a <ConversationProvider>');
  }
  return value;
}
