'use client';

/**
 * ChatTranscript — the conversation as it reads: turns, reasoning traces, side-band notices, the
 * question card and the inline correction strip. Everything except the box you type into.
 *
 * Split out of `QuestionnaireChat` when `conversation` became two slots (`transcript` +
 * `composer`), so a layout may place the two apart — the Broadsheet layout runs the transcript as
 * a document and puts the composer in the margin beside it. Classic and Focus stack them back
 * together in a single card via `ConversationFrame`, which is why this file draws no card chrome
 * of its own: whoever places it supplies the frame.
 *
 * Chrome-free, but NOT state-free in isolation: the reveal queue that types assistant turns in one
 * at a time lives in {@link useConversation}, because the composer is gated on the same clock and
 * the two halves may now have no common ancestor but the provider `SessionWorkspace` mounts. See
 * `conversation-context.tsx` for why that state, and only that state, is shared.
 *
 * The column's width is the `.cq-chat-measure` utility, not a fixed `max-w-*`: it is sized as a
 * multiple of the respondent's text-size preference AND the viewport scale, so the line length
 * stays constant in characters while the conversation grows to suit a larger display. The composer
 * carries the same measure so the two stay aligned at every size — a `region`-placed composer in a
 * margin narrower than the measure simply fills its rail, since the measure is a max-width.
 *
 * Brand colours come from CSS custom properties (`--app-accent-color`) with platform-default
 * fallbacks, so the theming layer activates with no change here.
 */

import { useEffect, useRef, useState } from 'react';
import { GlossaryMarkdown } from '@/components/app/questionnaire/glossary/glossary-markdown';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';

import { cn } from '@/lib/utils';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { SessionWarning } from '@/lib/app/questionnaire/chat/types';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';
import type { ReasoningStep } from '@/lib/app/questionnaire/reasoning';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import { useConversation } from '@/components/app/questionnaire/chat/conversation-context';
import { ChatErrorPanel } from '@/components/app/questionnaire/chat/chat-error-panel';
import { ReleaseStageNotice } from '@/components/app/questionnaire/chat/release-stage-notice';
import { CorrectionStrip } from '@/components/app/questionnaire/chat/correction-strip';
import { QuestionCard } from '@/components/app/questionnaire/chat/question-card';
import { ContradictionNotice } from '@/components/app/questionnaire/chat/contradiction-notice';
import { MilestoneNotice } from '@/components/app/questionnaire/chat/milestone-notice';
import { SeriousnessNotice } from '@/components/app/questionnaire/chat/seriousness-notice';
import { SupportNotice } from '@/components/app/questionnaire/chat/support-notice';
import {
  ReasoningTrace,
  AUTO_REVEAL_DWELL_MS,
  AUTO_REVEAL_PER_ITEM_MS,
  AUTO_REVEAL_COLLAPSE_MS,
  computeReasoningDwellMs,
} from '@/components/app/questionnaire/chat/reasoning-trace';
import { TurnInspectorDrawer } from '@/components/app/questionnaire/chat/turn-inspector-drawer';
import { SeamDivider } from '@/components/app/questionnaire/experiences/seam-divider';
import type { StitchedHistory } from '@/lib/app/questionnaire/experiences/run/types';

/**
 * The side-band notices that belong to one assistant turn, rendered inline beneath it. A flagged
 * contradiction (F4.3) gets a tasteful callout — the clearest "the agent is reasoning about your
 * answers" signal; seriousness/support/milestone get their bespoke notices; every other code stays
 * a quiet fail-soft line. Attached to the turn (not a transient banner), so they persist as the
 * conversation scrolls on and replay on resume. Renders nothing when the turn raised none.
 */
function TurnNotices({ warnings }: { warnings?: SessionWarning[] }) {
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
function TurnReasoning({
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

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div
        // No font-size class: the size is inherited from the `.cq-chat-scale` transcript wrapper so
        // the respondent's preference drives it.
        className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 leading-relaxed whitespace-pre-wrap"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 12%, transparent)',
          color: 'var(--color-foreground)',
        }}
      >
        {content}
      </div>
    </div>
  );
}

function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-2.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: 'var(--app-accent-color, var(--color-primary))' }}
      />
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
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
const OPENING_FIRST_THINK_MS = 1000;
const OPENING_GAP_MS = 1500;

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
function RevealedAssistantTurn({
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

export interface ChatTranscriptProps {
  /** The session id powering the question card's submit and the inspector drawer. */
  sessionId: string;
  /**
   * Definitions / glossary (P16): the version's live terms. A matched term is underlined in the
   * interviewer's messages with its definition in a popover. Resolved server-side and already
   * gated on `glossaryRespondentHints` — the page passes `[]` when the switch is off, so this
   * surface carries no flag of its own. Never annotates the RESPONDENT's own messages: only the
   * assistant-turn bodies below are wrapped.
   */
  glossary?: readonly GlossaryEntry[];
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** The shared stream state, owned by `SessionWorkspace`. */
  stream: UseQuestionnaireSessionStreamReturn;
  /**
   * "Watch it think" reasoning placement (demo feature) — `overlay` ("Animated") mounts the newest
   * turn's collapsed trace open then animates it closed after a beat; `inline` shows the quiet
   * collapsed trace beneath each turn (opens on click only). `undefined`/null = the feature is off.
   */
  reasoningPlacement?: ReasoningPlacement | null;
  /**
   * "Animated" placement timing (ms): how long the newest turn's reasoning summary stays open for
   * up to two steps. Defaults to {@link AUTO_REVEAL_DWELL_MS}. Admin-tunable per version.
   */
  reasoningDwellMs?: number;
  /**
   * "Animated" placement timing (ms): extra dwell added per reasoning step beyond two, so a longer
   * summary stays open long enough to read. Defaults to {@link AUTO_REVEAL_PER_ITEM_MS}.
   */
  reasoningPerItemMs?: number;
  /**
   * Inline answer correction (Variant B): the slots the most-recent turn captured, resolved to
   * editable targets. When non-empty (and the reply has settled) a {@link CorrectionStrip} renders
   * beneath the transcript so the respondent can fix a just-captured answer inline.
   */
  correctionTargets?: CorrectionTarget[];
  /** Refetch the panel/lifecycle after a successful inline correction. */
  onCorrected?: (view: AnswerPanelView) => void;
  /**
   * Experiences, `stitched` continuity (P15.3): the earlier legs of this run, replayed above the
   * live conversation. Read-only and settled — never animated, never part of the reveal queue.
   */
  stitchedHistory?: StitchedHistory | null;
  /**
   * The divider label introducing the LIVE leg, when history precedes it. `null` suppresses every
   * seam divider (the author chose the seamless marker); `undefined` means not stitched at all.
   */
  stitchedSeamLabel?: string | null;
  /**
   * Read-only replay: the admin session viewer reading a respondent's conversation. Suppresses the
   * pre-release notice (the admin is not the recorded party) and every answer affordance — there is
   * no composer beside it either, but these are hidden independently of that.
   */
  readOnly?: boolean;
  className?: string;
}

export function ChatTranscript({
  sessionId,
  glossary,
  accessToken,
  stream,
  reasoningPlacement,
  reasoningDwellMs = AUTO_REVEAL_DWELL_MS,
  reasoningPerItemMs = AUTO_REVEAL_PER_ITEM_MS,
  correctionTargets = [],
  onCorrected,
  stitchedHistory,
  stitchedSeamLabel,
  readOnly = false,
  className,
}: ChatTranscriptProps) {
  const {
    turns,
    streaming,
    inspectorTurns,
    status,
    error,
    continueAfterCard,
    dismissError,
    retry,
  } = stream;

  const {
    revealCursor,
    advanceReveal,
    openingTurnCount,
    animateOpening,
    composerReady,
    isTerminal,
  } = useConversation();

  const bottomRef = useRef<HTMLDivElement>(null);

  // The answer control belonging to the CURRENT turn, if any. Reading only the last turn is what
  // keeps exactly one card on screen: a new turn retires the previous card automatically.
  const activeCard = turns[turns.length - 1]?.card;
  // Dismissal is keyed on the TURN, not the question. Keying it on the question key would suppress
  // the control permanently: a must-ask question the respondent dismissed stays unsatisfied, so the
  // interviewer re-asks it on a later turn — and a prose answer can't clear the 0.85 must-ask floor
  // on its own (opportunistic fill caps at 0.75), so the question would stall until the session cap
  // with no way back to the control that could actually answer it.
  const [dismissedTurnIndex, setDismissedTurnIndex] = useState<number | null>(null);
  const cardDismissed = activeCard !== undefined && dismissedTurnIndex === turns.length - 1;

  /**
   * The pre-type "Thinking…" beat for the assistant turn at `index`. Only during the OPENING burst
   * (animating, and no respondent message has appeared yet): ~1s before the first message, ~1.5s
   * before each subsequent one. Zero everywhere else — ordinary replies type as soon as they land
   * (the in-flight `streaming` indicator already covered their compose time).
   */
  const beatForTurn = (index: number): number => {
    if (!animateOpening) return 0;
    const inOpeningBurst = !turns.slice(0, index).some((t) => t.role === 'user');
    if (!inOpeningBurst) return 0;
    return index === 0 ? OPENING_FIRST_THINK_MS : OPENING_GAP_MS;
  };

  // Keep the latest turn / thinking indicator in view (also as the queue advances).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, streaming, revealCursor]);

  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 2xl:px-10', className)}>
      {/* Preview Turn Inspector (admin only): a fixed right-edge console, mounted only once the
          server has emitted inspector frames — which it does solely for a preview session with the
          toggle on, so it never appears for a real respondent. It portals to <body>, so it sits
          here purely for co-location and adds nothing to this element's box. */}
      {inspectorTurns.length > 0 && (
        <TurnInspectorDrawer turns={inspectorTurns} sessionId={sessionId} messages={turns} />
      )}
      {/* `cq-chat-scale` resolves the respondent's text-size preference from the `--cq-chat-scale`
          custom property SessionWorkspace sets; the bubbles below inherit it rather than pinning
          their own size. */}
      <div className="cq-chat-scale cq-chat-measure flex flex-col gap-6">
        {/* Pre-release transparency notice — lives at the top of the transcript so it scrolls
            away with the conversation rather than pinning above it. Never shown in the
            read-only admin viewer (the admin isn't the recorded party). Renders nothing once
            the product is `stable`. */}
        {!readOnly && <ReleaseStageNotice />}
        {/* Experiences, `stitched` continuity (P15.3): the earlier legs of this run, replayed
            above the live conversation so the journey reads as one. Rendered as its own block
            rather than concatenated into `turns` — the reveal cursor, the typewriter and the
            inspector all index that array, and history must settle instantly and animate
            nothing. `stitchedSeamLabel` is null when the author chose the seamless marker. */}
        {stitchedHistory?.segments.map((segment, s) => (
          <div key={`seg-${s}`} className="flex flex-col gap-6">
            {stitchedSeamLabel !== null && s > 0 && <SeamDivider label={segment.stepTitle} />}
            {segment.turns.map((turn, t) =>
              turn.role === 'user' ? (
                <UserBubble key={`seg-${s}-t-${t}`} content={turn.content} />
              ) : (
                <AssistantTurn key={`seg-${s}-t-${t}`}>
                  <TurnReasoning steps={turn.reasoning} placement={reasoningPlacement} />
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <GlossaryMarkdown glossary={glossary}>{turn.content}</GlossaryMarkdown>
                  </div>
                  <TurnNotices warnings={turn.warnings} />
                </AssistantTurn>
              )
            )}
          </div>
        ))}
        {/* The divider introducing the LIVE leg — shown only when history precedes it. */}
        {stitchedSeamLabel !== null &&
          stitchedSeamLabel !== undefined &&
          (stitchedHistory?.segments.length ?? 0) > 0 && <SeamDivider label={stitchedSeamLabel} />}
        {turns.map((turn, i) => {
          if (turn.role === 'user') return <UserBubble key={i} content={turn.content} />;

          // Reveal queue. Turns past the cursor stay hidden until the queue reaches them, so a
          // freshly-arrived assistant turn can't type over the one before it.
          if (i > revealCursor) return null;

          // History on a resumed session settles instantly (rendered before the queue's first
          // active turn) — no typewriter, no beat.
          if (i < revealCursor && !animateOpening && i < openingTurnCount) {
            return (
              <AssistantTurn key={i}>
                {/* Reasoning above the reply — directly under the message it processed. */}
                <TurnReasoning steps={turn.reasoning} placement={reasoningPlacement} />
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <GlossaryMarkdown glossary={glossary}>{turn.content}</GlossaryMarkdown>
                </div>
                {/* Replayed transcript: its persisted notices render beneath the turn. */}
                <TurnNotices warnings={turn.warnings} />
              </AssistantTurn>
            );
          }

          // The active turn (and already-typed ones, which re-render settled): beat → type, and
          // advance the queue on completion. A settled turn passes beat 0 and a no-op onDone.
          const isActive = i === revealCursor;
          // "Animated" placement auto-reveals only the NEWEST turn, and only when it arrived this
          // session (index past the resumed history) — so a reload doesn't flash every turn open.
          const reasoningAutoReveal =
            reasoningPlacement === 'overlay' && i === turns.length - 1 && i >= openingTurnCount;
          // The open duration scales with how much there is to read: base dwell for up to two
          // steps, plus the per-item dwell for each step beyond. Both come from the version config.
          const stepCount = turn.reasoning?.length ?? 0;
          const reasoningDwell = computeReasoningDwellMs(
            stepCount,
            reasoningDwellMs,
            reasoningPerItemMs
          );
          // When the trace auto-reveals AND this turn actually has steps to show, hold the reply
          // back until the trace has dwelled and finished tucking away — so the next question
          // doesn't appear until the reasoning summary closes. No steps ⇒ no hold (no dead air).
          const reasoningHoldMs =
            reasoningAutoReveal && stepCount > 0 ? reasoningDwell + AUTO_REVEAL_COLLAPSE_MS : 0;
          return (
            <RevealedAssistantTurn
              key={i}
              content={turn.content}
              warnings={turn.warnings}
              reasoning={turn.reasoning}
              reasoningPlacement={reasoningPlacement}
              reasoningAutoReveal={reasoningAutoReveal}
              reasoningDwellMs={reasoningDwell}
              reasoningHoldMs={reasoningHoldMs}
              beatMs={isActive ? beatForTurn(i) : 0}
              glossary={glossary}
              onDone={isActive ? () => advanceReveal(i) : () => {}}
            />
          );
        })}

        {/* Awaiting a reply — a calm "thinking" indicator. The reply then types itself in once
            it lands as a committed turn (above). Only shown once the reveal queue has caught up
            to every committed turn, so it never doubles with an active turn's own beat/typing
            while earlier opening messages are still revealing. */}
        {streaming && revealCursor >= turns.length && (
          <AssistantTurn>
            {/* A calm "thinking" indicator stands in while the reply composes; the reasoning trace
                reveals on the settled turn (above), tucking itself away under the "Animated"
                placement. */}
            <ThinkingIndicator className="min-h-6" />
          </AssistantTurn>
        )}

        {/* Blocking / error state */}
        {error && (
          <ChatErrorPanel
            status={status}
            error={error}
            onDismiss={status === 'error' ? dismissError : undefined}
            // `retry` is async; the panel's onRetry is fire-and-forget (void).
            onRetry={status === 'error' ? () => void retry() : undefined}
          />
        )}

        {/* Question fidelity (P18): the current question's REAL answer control. Rendered only for
            the LATEST turn — a card left attached to an older turn would invite the respondent to
            answer something the conversation has already moved past, and the submit would
            overwrite a newer answer. Dismissing it hands them back to the composer without
            marking the question answered, so the interviewer still comes back to it. */}
        {!readOnly && !isTerminal && composerReady && activeCard && !cardDismissed && (
          <QuestionCard
            card={activeCard}
            sessionId={sessionId}
            accessToken={accessToken}
            onAnswered={(view) => {
              onCorrected?.(view);
              void continueAfterCard(activeCard.questionKey);
            }}
            onDismiss={() => setDismissedTurnIndex(turns.length - 1)}
          />
        )}

        {/* Inline correction (Variant B): once the latest reply has fully settled (composerReady),
            offer a quiet "fix what I just noted" strip for the slots this turn captured — so a
            mis-heard answer is corrected here, not via a corrective turn that could trip a false
            contradiction warning. Hidden in read-only replay and terminal states. */}
        {!readOnly && !isTerminal && composerReady && correctionTargets.length > 0 && (
          <CorrectionStrip
            targets={correctionTargets}
            sessionId={sessionId}
            accessToken={accessToken}
            onCorrected={(view) => onCorrected?.(view)}
          />
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
