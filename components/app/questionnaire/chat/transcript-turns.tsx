'use client';

/**
 * The turn primitives — how one turn of the conversation reads, wherever it is placed.
 *
 * Extracted when `transcript` split into `history` + `currentExchange` (the granularity Horizon
 * needs). Both halves render turns, and a turn crosses between them the moment the respondent
 * sends a message, so the two must draw one identically or the boundary would be visible as a
 * flicker in every layout that shows them adjacent — which is every layout but Horizon.
 *
 * Nothing here reads session state, fetches, or decides which turns to show. It is the vocabulary
 * of a turn: a respondent's bubble, an interviewer's turn, its reasoning trace, its notices, and
 * the two ways an interviewer's turn arrives — settled (history, replay, resume) or revealed (the
 * live one, typing itself in).
 */

import { useEffect, useRef, useState } from 'react';

import { GlossaryMarkdown } from '@/components/app/questionnaire/glossary/glossary-markdown';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import type { SessionWarning } from '@/lib/app/questionnaire/chat/types';
import type { ReasoningStep } from '@/lib/app/questionnaire/reasoning';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import { ContradictionNotice } from '@/components/app/questionnaire/chat/contradiction-notice';
import { MilestoneNotice } from '@/components/app/questionnaire/chat/milestone-notice';
import { SeriousnessNotice } from '@/components/app/questionnaire/chat/seriousness-notice';
import { SupportNotice } from '@/components/app/questionnaire/chat/support-notice';
import { ReasoningTrace } from '@/components/app/questionnaire/chat/reasoning-trace';

/**
 * The side-band notices that belong to one assistant turn, rendered inline beneath it. A flagged
 * contradiction (F4.3) gets a tasteful callout — the clearest "the agent is reasoning about your
 * answers" signal; seriousness/support/milestone get their bespoke notices; every other code stays
 * a quiet fail-soft line. Attached to the turn (not a transient banner), so they persist as the
 * conversation scrolls on and replay on resume. Renders nothing when the turn raised none.
 */
export function TurnNotices({ warnings }: { warnings?: SessionWarning[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {warnings.map((warning, i) =>
        warning.code === 'contradiction' ? (
          <ContradictionNotice key={i} message={warning.message} detail={warning.detail} />
        ) : warning.code === 'seriousness' || warning.code === 'seriousness_final' ? (
          <SeriousnessNotice
            key={i}
            message={warning.message}
            detail={warning.detail}
            final={warning.code === 'seriousness_final'}
          />
        ) : warning.code === 'support' ? (
          <SupportNotice key={i} message={warning.message} />
        ) : warning.code === 'milestone' ? (
          <MilestoneNotice key={i} message={warning.message} />
        ) : (
          <div
            key={i}
            role="status"
            className="border-l-2 pl-3 text-xs"
            style={{ borderColor: 'var(--app-accent-color, var(--color-primary))' }}
          >
            <span className="text-muted-foreground">{warning.message}</span>
          </div>
        )
      )}
    </div>
  );
}

/**
 * The collapsed reasoning trace for one assistant turn, rendered **above** the reply — directly under
 * the respondent's message it processed, before the agent's reply. The trace is about reading that
 * message and choosing what to ask next, so it belongs there, not below the reply. Renders nothing
 * when the feature is off (no placement) or the turn had no trace.
 *
 * `autoReveal` (the "Animated"/`overlay` placement, newest turn only) makes it mount open and tuck
 * itself away after a beat; otherwise it mounts closed (the quiet "Inline" disclosure, and every
 * historical turn).
 */
export function TurnReasoning({
  steps,
  placement,
  autoReveal = false,
  dwellMs,
}: {
  steps?: ReasoningStep[];
  placement?: ReasoningPlacement | null;
  autoReveal?: boolean;
  /** How long the trace stays open under `autoReveal` (ms) — sized to the step count by the caller. */
  dwellMs?: number;
}) {
  if (!placement || !steps || steps.length === 0) return null;
  return (
    <ReasoningTrace steps={steps} autoReveal={autoReveal} dwellMs={dwellMs} className="mb-2.5" />
  );
}

export function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div
        // No font-size class: the size is inherited from the `.cq-chat-scale` transcript wrapper so
        // the respondent's preference drives it.
        // `cq-user-bubble` is the design axis's handle on this block, and the fill moved to a
        // custom property so a design can restate it without fighting an inline value. The fallback
        // is the literal that used to be here, so a transcript rendered OUTSIDE a design scope (the
        // read-only admin replay) is byte-for-byte what it always was.
        className="cq-user-bubble max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 leading-relaxed whitespace-pre-wrap"
        style={{
          backgroundColor:
            'var(--cq-user-bubble-bg, color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 12%, transparent))',
          color: 'var(--color-foreground)',
        }}
      >
        {content}
      </div>
    </div>
  );
}

export function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      {/* The interviewer's mark. A 8px accent dot by default — and the one element the `marque`
          design repurposes, painting the CLIENT's logo mark over it so their brand signs every
          question rather than sitting in a banner people stop seeing. The accent stays underneath
          as the background COLOUR, so a client with no mark degrades to a small brand block instead
          of to nothing. See app/respondent-design.css. */}
      <span
        aria-hidden="true"
        className="cq-turn-mark mt-2.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: 'var(--app-accent-color, var(--color-primary))' }}
      />
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * An interviewer turn that is simply *there*: reasoning above, the reply as Markdown, its notices
 * beneath. No beat, no typewriter, no reveal queue.
 *
 * Every settled turn goes through here — the replayed history of a resumed session, an earlier
 * Experience leg under `stitched` continuity, and (since the split) anything that has fallen behind
 * the current exchange. Declared once rather than three times, because three copies of "a turn at
 * rest" is how one of them ends up rendering its notices and the others quietly not.
 */
export function SettledAssistantTurn({
  content,
  warnings,
  reasoning,
  reasoningPlacement,
  glossary,
}: {
  content: string;
  warnings?: SessionWarning[];
  reasoning?: ReasoningStep[];
  reasoningPlacement?: ReasoningPlacement | null;
  glossary?: readonly GlossaryEntry[];
}) {
  return (
    <AssistantTurn>
      {/* Reasoning above the reply — directly under the message it processed. */}
      <TurnReasoning steps={reasoning} placement={reasoningPlacement} />
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <GlossaryMarkdown glossary={glossary}>{content}</GlossaryMarkdown>
      </div>
      <TurnNotices warnings={warnings} />
    </AssistantTurn>
  );
}

/** Typing cadence — chars revealed per tick and the gap between ticks (~150 chars/s). */
const TYPE_CHARS_PER_TICK = 3;
const TYPE_TICK_MS = 20;
/**
 * Opening choreography: a "Thinking…" indicator precedes each seeded opening message. A ~1s beat
 * before the FIRST message types, then a ~1.5s beat before each subsequent one — so the greeting
 * and the first question land like a person composing them, not all at once.
 */
export const OPENING_FIRST_THINK_MS = 1000;
export const OPENING_GAP_MS = 1500;

/**
 * An assistant turn that types itself in a few characters at a time — then settles to the
 * normal Markdown render once complete — so questions and replies arrive like streamed LLM
 * output rather than snapping in as a finished block.
 *
 * A plain `setInterval` (not the SSE rAF animator) is used deliberately: it's resilient to
 * React 19 StrictMode's mount→cleanup→remount in dev (cleanup clears the timer, the re-run
 * restarts cleanly from zero) where the ref-driven rAF animator would be cancelled and never
 * re-kicked, leaving a frozen caret with no text.
 */
function TypewriterAssistantTurn({
  content,
  warnings,
  reasoning,
  reasoningPlacement,
  reasoningAutoReveal = false,
  reasoningDwellMs,
  reasoningHoldMs = 0,
  glossary,
  onDone,
}: {
  content: string;
  /** Live glossary terms to underline once the reply has settled. */
  glossary?: readonly GlossaryEntry[];
  /** Side-band notices to render beneath the reply once it has finished typing in. */
  warnings?: SessionWarning[];
  /** The turn's reasoning trace, rendered collapsed beneath the reply once it has typed in. */
  reasoning?: ReasoningStep[];
  reasoningPlacement?: ReasoningPlacement | null;
  /** "Animated" placement, newest turn: mount the trace open and tuck it away after a beat. */
  reasoningAutoReveal?: boolean;
  /** How long the auto-revealed trace stays open (ms) — sized to the step count by the caller. */
  reasoningDwellMs?: number;
  /**
   * Hold the reply back for this long (ms) before it types in — used by the "Animated" placement so
   * the next question doesn't appear until the auto-revealed reasoning has finished tucking away.
   * `0` types immediately. The reasoning trace is rendered throughout the hold (it owns its own
   * open→close timing); only the reply is gated.
   */
  reasoningHoldMs?: number;
  /** Fired once when the message has fully typed in (used to chain the opening turns). */
  onDone?: () => void;
}) {
  const [shown, setShown] = useState(0);
  // Gate the reply on the reasoning's dwell+collapse so the question doesn't race the trace closing.
  const [holding, setHolding] = useState(reasoningHoldMs > 0);
  // Keep the latest callback without re-running the typing effect (which would restart the timer).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (reasoningHoldMs <= 0) return;
    const t = setTimeout(() => setHolding(false), reasoningHoldMs);
    return () => clearTimeout(t);
  }, [reasoningHoldMs]);

  useEffect(() => {
    // Don't start typing while the reasoning is still on screen — the reply waits for the hold.
    if (holding) return;
    setShown(0);
    if (content.length === 0) {
      onDoneRef.current?.();
      return;
    }
    let revealed = 0;
    const id = setInterval(() => {
      revealed = Math.min(revealed + TYPE_CHARS_PER_TICK, content.length);
      setShown(revealed);
      if (revealed >= content.length) {
        clearInterval(id);
        onDoneRef.current?.();
      }
    }, TYPE_TICK_MS);
    return () => clearInterval(id);
  }, [content, holding]);

  const done = shown >= content.length;
  return (
    <AssistantTurn>
      {/* Reasoning sits ABOVE the reply. Under the "Animated" placement it shows open first, then
          tucks away — and the reply is held back (below) until it has, so it reads as
          "here's what I worked out" → (tucks away) → "now my question." */}
      <TurnReasoning
        steps={reasoning}
        placement={reasoningPlacement}
        autoReveal={reasoningAutoReveal}
        dwellMs={reasoningDwellMs}
      />
      {/* While holding, only the reasoning is on screen — the reply has not begun yet. */}
      {holding ? null : done ? (
        <>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <GlossaryMarkdown glossary={glossary}>{content}</GlossaryMarkdown>
          </div>
          {/* The notices only land once the reply has fully typed in — they read as the agent's
              considered aside, not something racing the message itself. */}
          <TurnNotices warnings={warnings} />
        </>
      ) : (
        // Size inherited from `.cq-chat-scale` — the typing text must match the settled Markdown it
        // becomes, or the reply visibly jumps size the moment the typewriter finishes.
        <p className="leading-relaxed whitespace-pre-wrap">
          {content.slice(0, shown)}
          <span className="terminal-caret" aria-hidden="true">
            ▋
          </span>
        </p>
      )}
    </AssistantTurn>
  );
}

/**
 * The active assistant turn in the reveal queue: an optional "Thinking…" beat (a person
 * composing) followed by the typewriter. Self-contained so it owns its own beat timer — once
 * it's mounted (when the queue reaches it), a parent re-render (e.g. a new turn arriving) can't
 * restart or skip its beat. `onDone` fires when the message has fully typed in, which the parent
 * uses to advance the queue to the next turn.
 */
export function RevealedAssistantTurn({
  content,
  warnings,
  reasoning,
  reasoningPlacement,
  reasoningAutoReveal = false,
  reasoningDwellMs,
  reasoningHoldMs = 0,
  beatMs,
  glossary,
  onDone,
}: {
  content: string;
  /** Live glossary terms to underline once the reply has settled. */
  glossary?: readonly GlossaryEntry[];
  /** Side-band notices to render beneath the reply once it has finished typing in. */
  warnings?: SessionWarning[];
  /** The turn's reasoning trace, rendered collapsed beneath the reply once it has typed in. */
  reasoning?: ReasoningStep[];
  reasoningPlacement?: ReasoningPlacement | null;
  /** "Animated" placement, newest turn: mount the trace open and tuck it away after a beat. */
  reasoningAutoReveal?: boolean;
  /** How long the auto-revealed trace stays open (ms) — sized to the step count by the caller. */
  reasoningDwellMs?: number;
  /** Hold the reply back until the auto-revealed reasoning has tucked away (ms); `0` = no hold. */
  reasoningHoldMs?: number;
  /** Pre-type "Thinking…" pause in ms; `0` types immediately (a normal post-answer reply). */
  beatMs: number;
  onDone: () => void;
}) {
  const [thinking, setThinking] = useState(beatMs > 0);
  useEffect(() => {
    if (beatMs <= 0) return;
    const t = setTimeout(() => setThinking(false), beatMs);
    return () => clearTimeout(t);
  }, [beatMs]);

  if (thinking) {
    return (
      <AssistantTurn>
        {/* `min-h-6` matches the 24px first-line box the accent dot is positioned against — the
            indicator's own row is only 20px tall, which would leave the dot sitting below it. */}
        <ThinkingIndicator className="min-h-6" />
      </AssistantTurn>
    );
  }
  return (
    <TypewriterAssistantTurn
      content={content}
      warnings={warnings}
      reasoning={reasoning}
      reasoningPlacement={reasoningPlacement}
      reasoningAutoReveal={reasoningAutoReveal}
      reasoningDwellMs={reasoningDwellMs}
      reasoningHoldMs={reasoningHoldMs}
      glossary={glossary}
      onDone={onDone}
    />
  );
}
