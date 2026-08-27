'use client';

/**
 * ChatTranscript — the conversation as it reads, whole: turns, reasoning traces, side-band notices,
 * the question card and the inline correction strip. Everything except the box you type into.
 *
 * As of the `history` / `currentExchange` split this is an ASSEMBLY, not an implementation — the
 * reading column with the pre-release notice, the settled history and the live exchange stacked in
 * it, which is what the transcript has always been. It stays because two callers want the
 * conversation as one indivisible thing: the read-only admin replay and `QuestionnaireChat` (which
 * the replay renders). Its props and its DOM are unchanged by the split.
 *
 * The respondent surface itself does NOT come through here. `SessionWorkspace` hands `history` and
 * `currentExchange` to the layout as separate slots, so Horizon can put one question on a stage and
 * the history behind a gesture. Both paths render the same components in the same order — see
 * `transcript-column.tsx` for why the column is shared rather than duplicated.
 *
 * Chrome-free, but NOT state-free in isolation: the reveal queue that types assistant turns in one
 * at a time lives in {@link useConversation}, because the composer is gated on the same clock and
 * the halves may have no common ancestor but the provider `SessionWorkspace` mounts. See
 * `conversation-context.tsx` for why that state, and only that state, is shared.
 */

import { ChatHistory } from '@/components/app/questionnaire/chat/chat-history';
import { CurrentExchange } from '@/components/app/questionnaire/chat/current-exchange';
import { TranscriptColumn } from '@/components/app/questionnaire/chat/transcript-column';
import { ReleaseStageNotice } from '@/components/app/questionnaire/chat/release-stage-notice';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import type { StitchedHistory } from '@/lib/app/questionnaire/experiences/run/types';

export interface ChatTranscriptProps {
  /** The session id powering the question card's submit and the inspector drawer. */
  sessionId: string;
  /**
   * Definitions / glossary (P16): the version's live terms. A matched term is underlined in the
   * interviewer's messages with its definition in a popover. Resolved server-side and already
   * gated on `glossaryRespondentHints` — the page passes `[]` when the switch is off, so this
   * surface carries no flag of its own. Never annotates the RESPONDENT's own messages: only the
   * assistant-turn bodies are wrapped.
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
   * up to two steps. Admin-tunable per version.
   */
  reasoningDwellMs?: number;
  /**
   * "Animated" placement timing (ms): extra dwell added per reasoning step beyond two, so a longer
   * summary stays open long enough to read.
   */
  reasoningPerItemMs?: number;
  /**
   * Inline answer correction (Variant B): the slots the most-recent turn captured, resolved to
   * editable targets. When non-empty (and the reply has settled) a correction strip renders beneath
   * the exchange so the respondent can fix a just-captured answer inline.
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
  reasoningDwellMs,
  reasoningPerItemMs,
  correctionTargets = [],
  onCorrected,
  stitchedHistory,
  stitchedSeamLabel,
  readOnly = false,
  className,
}: ChatTranscriptProps) {
  return (
    <TranscriptColumn className={className}>
      {/* Pre-release transparency notice — at the head of the conversation, where it scrolls away
          with it rather than pinning above. Never shown in the read-only admin viewer (the admin
          isn't the recorded party). Renders nothing once the product is `stable`. On the respondent
          surface this is a slot of its own, so that a layout which puts the history behind a
          gesture cannot put the recording notice there with it. */}
      {!readOnly && <ReleaseStageNotice />}
      <ChatHistory
        stream={stream}
        glossary={glossary}
        reasoningPlacement={reasoningPlacement}
        stitchedHistory={stitchedHistory}
        stitchedSeamLabel={stitchedSeamLabel}
      />
      <CurrentExchange
        sessionId={sessionId}
        glossary={glossary}
        accessToken={accessToken}
        stream={stream}
        reasoningPlacement={reasoningPlacement}
        reasoningDwellMs={reasoningDwellMs}
        reasoningPerItemMs={reasoningPerItemMs}
        correctionTargets={correctionTargets}
        onCorrected={onCorrected}
        readOnly={readOnly}
      />
    </TranscriptColumn>
  );
}
