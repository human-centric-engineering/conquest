'use client';

/**
 * QuestionnaireChat — the respondent-facing conversational surface (F7.1), whole.
 *
 * A bespoke chat client rendering the respondent turn loop. Deliberately NOT the admin
 * `ChatInterface` (that one is wired to the orchestration `agentSlug` endpoint); this
 * consumes the questionnaire `/messages` SSE contract and renders a calm, focused
 * conversation rather than a tool-trace console.
 *
 * As of the `transcript` / `composer` slot split this is an ASSEMBLY, not an implementation: the
 * conversation state provider, the transcript, and the composer, stacked in the card they have
 * always shared. It stays because two callers want the conversation as one indivisible thing —
 * the read-only admin replay (`readOnly`, no composer at all) and anything embedding a
 * conversation outside the layout contract — and because a component that owns its own provider is
 * the only way to render a conversation without a `SessionWorkspace` above it.
 *
 * The respondent surface itself does NOT come through here. `SessionWorkspace` mounts the provider
 * above the whole layout and hands `transcript` and `composer` to it as separate slots, so a layout
 * may place them apart. Both paths render the same three components in the same order — see
 * `conversation-frame.tsx` for why the card and its seam are shared rather than duplicated.
 *
 * The stream state is owned by {@link SessionWorkspace} (which also drives the answer
 * panel from the same session) and passed in via `stream`, so the chat and the panel
 * share one {@link useQuestionnaireSessionStream} instance — that's what lets the
 * panel's "Revisit" action send a turn through this same loop.
 */

import { ConversationProvider } from '@/components/app/questionnaire/chat/conversation-context';
import { ConversationFrame } from '@/components/app/questionnaire/chat/conversation-frame';
import { ChatTranscript } from '@/components/app/questionnaire/chat/chat-transcript';
import { ChatComposer } from '@/components/app/questionnaire/chat/chat-composer';
import { isTerminalStatus } from '@/lib/app/questionnaire/chat/types';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import type { StitchedHistory } from '@/lib/app/questionnaire/experiences/run/types';

export interface QuestionnaireChatProps {
  /** The session id powering `/questionnaire-sessions/:id/messages` (used by the mic). */
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
  /** The shared stream state, owned by {@link SessionWorkspace}. */
  stream: UseQuestionnaireSessionStreamReturn;
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
  /** Show the attachment affordance (gated server-side on the attachment-input flag). */
  attachmentInputEnabled?: boolean;
  /**
   * "Watch it think" reasoning placement (demo feature) — `overlay` ("Animated") mounts the newest
   * turn's collapsed trace open then animates it closed after a beat; `inline` shows the quiet
   * collapsed trace beneath each turn (opens on click only). `undefined`/null = the feature is off
   * (no trace rendered), which is what the page passes when the version toggle is off.
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
   * Type the seeded opening turn(s) in (the welcome greeting) instead of snapping them in
   * fully-formed. Replies that arrive *after* mount always type in regardless; this flag only
   * governs the pre-seeded turns, so set it for fresh sessions (alongside `autoStart`) and leave
   * it off on resume so a restored transcript renders its history instantly.
   */
  animateOpening?: boolean;
  /**
   * Inline answer correction (Variant B): the slots the most-recent turn captured, resolved to
   * editable targets. When non-empty (and the reply has settled) a correction strip renders
   * beneath the transcript so the respondent can fix a just-captured answer inline. Empty/omitted
   * hides it. Resolved upstream in SessionWorkspace.
   */
  correctionTargets?: CorrectionTarget[];
  /** Refetch the panel/lifecycle after a successful inline correction. */
  onCorrected?: (view: AnswerPanelView) => void;
  /**
   * Experiences, `stitched` continuity (P15.3): the earlier legs of this run, replayed above the
   * live conversation. Read-only and settled — never animated, never part of the reveal queue.
   * Omitted/null for a standalone session and for `linked`, which is the overwhelming majority.
   */
  stitchedHistory?: StitchedHistory | null;
  /**
   * The divider label introducing the LIVE leg, when history precedes it. `null` suppresses every
   * seam divider (the author chose the seamless marker); `undefined` means not stitched at all.
   */
  stitchedSeamLabel?: string | null;
  /**
   * Read-only replay: render the transcript with no composer (no input, mic, or attachment row), for
   * the admin session viewer reading a respondent's conversation. The respondent surface never sets
   * this. Independent of the terminal-status composer hiding — a read-only `idle` session still hides
   * the composer.
   */
  readOnly?: boolean;
  className?: string;
}

export function QuestionnaireChat({
  sessionId,
  glossary,
  accessToken,
  stream,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  reasoningPlacement,
  reasoningDwellMs,
  reasoningPerItemMs,
  animateOpening = false,
  correctionTargets = [],
  onCorrected,
  stitchedHistory,
  stitchedSeamLabel,
  readOnly = false,
  className,
}: QuestionnaireChatProps) {
  // No composer once the session can take no further input, and none at all in the read-only
  // replay. Decided here (rather than inside the composer) so the frame is handed a `null` and
  // draws no seam above the absence — the same decision `SessionWorkspace` makes when it builds
  // the `composer` slot for a layout.
  const showComposer = !isTerminalStatus(stream.status) && !readOnly;

  return (
    <ConversationProvider stream={stream} animateOpening={animateOpening}>
      <ConversationFrame
        className={className}
        transcript={
          <ChatTranscript
            sessionId={sessionId}
            glossary={glossary}
            accessToken={accessToken}
            stream={stream}
            reasoningPlacement={reasoningPlacement}
            reasoningDwellMs={reasoningDwellMs}
            reasoningPerItemMs={reasoningPerItemMs}
            correctionTargets={correctionTargets}
            onCorrected={onCorrected}
            stitchedHistory={stitchedHistory}
            stitchedSeamLabel={stitchedSeamLabel}
            readOnly={readOnly}
          />
        }
        composer={
          showComposer ? (
            <ChatComposer
              sessionId={sessionId}
              accessToken={accessToken}
              stream={stream}
              voiceInputEnabled={voiceInputEnabled}
              attachmentInputEnabled={attachmentInputEnabled}
            />
          ) : null
        }
      />
    </ConversationProvider>
  );
}
