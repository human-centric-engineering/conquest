'use client';

/**
 * CurrentExchange — the live end of the conversation: the respondent's most recent message, and
 * everything the interviewer has said since.
 *
 * Everything that is still *happening* is here — the reveal queue typing a reply in, the thinking
 * indicator while one composes, the error panel, the question card belonging to the current
 * question, and the inline correction strip for what that turn just captured. `ChatHistory` holds
 * the rest, at rest.
 *
 * The boundary is a whole exchange rather than the last interviewer turn alone, because a question
 * read without the answer it followed is a question out of context — and because the opening burst
 * has no respondent message at all, so anchoring on it keeps the greeting and the first question
 * together (see `lib/app/questionnaire/chat/exchange.ts`).
 *
 * This is the half Horizon puts on its stage, one question at a time. In every other layout it is
 * stacked directly under the history in one reading column, where the boundary is invisible.
 * Draws no scroll container, padding or measure of its own — whoever places it supplies the column
 * — but it DOES own the bottom anchor, because "keep the newest thing in view" is a property of the
 * live end of a conversation and not of whatever box a layout put it in.
 */

import { useEffect, useRef, useState } from 'react';

import { useConversation } from '@/components/app/questionnaire/chat/conversation-context';
import {
  AssistantTurn,
  OPENING_FIRST_THINK_MS,
  OPENING_GAP_MS,
  RevealedAssistantTurn,
  SettledAssistantTurn,
  UserBubble,
} from '@/components/app/questionnaire/chat/transcript-turns';
import { ChatErrorPanel } from '@/components/app/questionnaire/chat/chat-error-panel';
import { CorrectionStrip } from '@/components/app/questionnaire/chat/correction-strip';
import { QuestionCard } from '@/components/app/questionnaire/chat/question-card';
import { TurnInspectorDrawer } from '@/components/app/questionnaire/chat/turn-inspector-drawer';
import {
  AUTO_REVEAL_DWELL_MS,
  AUTO_REVEAL_PER_ITEM_MS,
  AUTO_REVEAL_COLLAPSE_MS,
  computeReasoningDwellMs,
} from '@/components/app/questionnaire/chat/reasoning-trace';
import { TurnProgress } from '@/components/app/questionnaire/chat/turn-progress';
import { cn } from '@/lib/utils';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import { turnInSection } from '@/lib/app/questionnaire/chat/exchange';

export interface CurrentExchangeProps {
  /** The session id powering the question card's submit and the inspector drawer. */
  sessionId: string;
  /**
   * Definitions / glossary (P16): the version's live terms. A matched term is underlined in the
   * interviewer's messages with its definition in a popover. Never annotates the RESPONDENT's own
   * messages: only the assistant-turn bodies are wrapped.
   */
  glossary?: readonly GlossaryEntry[];
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** The shared stream state, owned by `SessionWorkspace`. */
  stream: UseQuestionnaireSessionStreamReturn;
  /** `overlay` ("Animated") | `inline`, or null/undefined when "watch it think" is off. */
  reasoningPlacement?: ReasoningPlacement | null;
  /** "Animated": how long the newest turn's summary stays open for up to two steps (ms). */
  reasoningDwellMs?: number;
  /** "Animated": extra dwell added per reasoning step beyond two (ms). */
  reasoningPerItemMs?: number;
  /**
   * Inline answer correction (Variant B): the slots the most-recent turn captured, resolved to
   * editable targets. When non-empty (and the reply has settled) a {@link CorrectionStrip} renders
   * beneath the exchange so the respondent can fix a just-captured answer inline.
   */
  correctionTargets?: CorrectionTarget[];
  /** Refetch the panel/lifecycle after a successful inline correction. */
  onCorrected?: (view: AnswerPanelView) => void;
  /**
   * Sectioned interviews (P21): show only the exchange belonging to this section.
   *
   * The same key and the same predicate `ChatHistory` takes, and it is needed HERE too because the
   * exchange boundary is anchored on the last respondent message. Moving to another section moves
   * no message, so the section they left keeps its final question and answer sitting past that
   * boundary — visible under the new section's name until the respondent speaks again. Filtering
   * one half and not the other is what made a section move look like it had changed nothing.
   *
   * It cannot strand the reveal queue. A turn can only be filtered out here by a section move, and
   * a move is only offered on `canSend`, which is false until the queue has emptied — so the turn
   * at the cursor is never the one that disappears.
   */
  sectionKey?: string | null;
  /**
   * Sectioned interviews (P21): where a turn carrying NO section of its own belongs — the run's
   * first section. See {@link turnInSection}; the surface passes it so the client-built greeting
   * does not reappear at the top of every section.
   */
  untaggedSectionKey?: string | null;
  /**
   * Read-only replay: the admin session viewer reading a respondent's conversation. Suppresses
   * every answer affordance — there is no composer beside it either, but these are hidden
   * independently of that.
   */
  readOnly?: boolean;
  className?: string;
}

export function CurrentExchange({
  sessionId,
  glossary,
  accessToken,
  stream,
  reasoningPlacement,
  reasoningDwellMs = AUTO_REVEAL_DWELL_MS,
  reasoningPerItemMs = AUTO_REVEAL_PER_ITEM_MS,
  correctionTargets = [],
  onCorrected,
  sectionKey,
  untaggedSectionKey,
  readOnly = false,
  className,
}: CurrentExchangeProps) {
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
    historyEnd,
    openingTurnCount,
    animateOpening,
    composerReady,
    isTerminal,
    stageLabel,
    handoverLabel,
  } = useConversation();

  const bottomRef = useRef<HTMLDivElement>(null);

  // The answer control belonging to the CURRENT turn, if any. Reading only the last turn is what
  // keeps exactly one card on screen: a new turn retires the previous card automatically. A last
  // turn belonging to another section retires it too — the card asks a question of the section the
  // respondent has just left, and its Submit would write an answer they are no longer looking at.
  const lastTurn = turns[turns.length - 1];
  const activeCard =
    lastTurn && turnInSection(lastTurn, sectionKey, untaggedSectionKey) ? lastTurn.card : undefined;
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

  // Keep the latest turn / thinking indicator in view (also as the queue advances). Scrolls
  // whichever ancestor actually scrolls, which is the layout's business rather than this one's.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    // `handoverLabel` is in here for the same reason `streaming` is: the beat appears below the
    // reply that announced it, and a cue the respondent has to scroll to find is not a cue.
  }, [turns.length, streaming, revealCursor, handoverLabel]);

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/* Preview Turn Inspector (admin only): a fixed right-edge console, mounted only once the
          server has emitted inspector frames — which it does solely for a preview session with the
          toggle on, so it never appears for a real respondent. It portals to <body>, so it sits
          here purely for co-location and adds nothing to this element's box. Mounted with the live
          exchange rather than the history because it is a console on what is happening now. */}
      {inspectorTurns.length > 0 && (
        <TurnInspectorDrawer turns={inspectorTurns} sessionId={sessionId} messages={turns} />
      )}

      {turns.map((turn, i) => {
        // Behind the boundary: `ChatHistory` is rendering this one, wherever the layout put it.
        if (i < historyEnd) return null;
        // P21: said in another section. Skipped by index rather than filtered out of the array, so
        // the reveal cursor keeps indexing the same turns it always did.
        //
        // Clamped to turns the queue has already passed, for the same reason `historyEnd` is
        // clamped: unmounting the turn the cursor is ON would take its `onDone` with it,
        // `advanceReveal` would never fire, and `composerReady` would stay false for the rest of
        // the session — a composer shut for good with nothing on screen to explain it. The window
        // is real, because the section control opens on `canSend`, which is true a beat before the
        // reply has finished typing. So a turn from another section that is still revealing simply
        // finishes, exactly as one crossing the history boundary does, and disappears on the next
        // render once the cursor is past it.
        if (i < revealCursor && !turnInSection(turn, sectionKey, untaggedSectionKey)) return null;
        if (turn.role === 'user') return <UserBubble key={i} content={turn.content} />;

        // Reveal queue. Turns past the cursor stay hidden until the queue reaches them, so a
        // freshly-arrived assistant turn can't type over the one before it.
        if (i > revealCursor) return null;

        // History on a resumed session settles instantly (rendered before the queue's first
        // active turn) — no typewriter, no beat.
        if (i < revealCursor && !animateOpening && i < openingTurnCount) {
          return (
            <SettledAssistantTurn
              key={i}
              content={turn.content}
              warnings={turn.warnings}
              reasoning={turn.reasoning}
              reasoningPlacement={reasoningPlacement}
              glossary={glossary}
            />
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

      {/* Awaiting a reply. The reply then types itself in once it lands as a committed turn
          (above). Only shown once the reveal queue has caught up to every committed turn, so it
          never doubles with an active turn's own beat/typing while earlier opening messages are
          still revealing. */}
      {(streaming || handoverLabel !== null) && revealCursor >= turns.length && (
        <AssistantTurn>
          {/* P20 Phase 2: the stage the server is actually on — paced and faded so a fast sequence
              is readable (F20.5) — plus an elapsed clock once the wait is long enough to warrant
              one. This is the one place a respondent watches the whole multi-call wait, so it is
              the one that gets both. It owns its own row height, which has to stay one row: the
              accent mark beside it is pinned to the turn's first line. The reasoning trace still
              reveals on the settled turn (above), tucking itself away under "Animated". */}
          {/* P21: between turns the same row carries the section handover beat — "Moving on to
              Growth Strategy…" — for the couple of seconds between the reply announcing the move
              and the move happening. The two can never collide: a stage label only exists while a
              turn is in flight, and the beat only runs when none is. */}
          <TurnProgress label={streaming ? stageLabel : handoverLabel} />
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
  );
}
