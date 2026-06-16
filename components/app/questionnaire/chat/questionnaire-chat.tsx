'use client';

/**
 * QuestionnaireChat — the respondent-facing conversational surface (F7.1).
 *
 * A bespoke chat client rendering the respondent turn loop. Deliberately NOT the admin
 * `ChatInterface` (that one is wired to the orchestration `agentSlug` endpoint); this
 * consumes the questionnaire `/messages` SSE contract and renders a calm, focused
 * conversation rather than a tool-trace console. The layout is a single readable column
 * so the answer-slot panel (F7.2) sits beside it in {@link SessionWorkspace}.
 *
 * The stream state is owned by {@link SessionWorkspace} (which also drives the answer
 * panel from the same session) and passed in via `stream`, so the chat and the panel
 * share one {@link useQuestionnaireSessionStream} instance — that's what lets the
 * panel's "Revisit" action send a turn through this same loop.
 *
 * Brand colours come from CSS custom properties (`--app-accent-color`, `--app-cta-color`,
 * `--app-cta-gradient`) with platform-default fallbacks, so the theming layer activates with
 * no change here — the send button picks up a brand gradient when one is configured. A `<div>`
 * (not a `<form>`) hosts the composer to stay safe if ever embedded.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import Markdown from 'react-markdown';

import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import { MicButton } from '@/components/admin/orchestration/chat/mic-button';
import {
  AttachmentPickerButton,
  AttachmentThumbnailStrip,
} from '@/components/admin/orchestration/chat/attachment-picker-button';
import { type AttachmentEntry } from '@/lib/hooks/use-attachments';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { SessionWarning } from '@/lib/app/questionnaire/chat/types';
import type { ReasoningStep } from '@/lib/app/questionnaire/reasoning';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import { ChatErrorPanel } from '@/components/app/questionnaire/chat/chat-error-panel';
import { ContradictionNotice } from '@/components/app/questionnaire/chat/contradiction-notice';
import { SeriousnessNotice } from '@/components/app/questionnaire/chat/seriousness-notice';
import { SupportNotice } from '@/components/app/questionnaire/chat/support-notice';
import { ReasoningTrace } from '@/components/app/questionnaire/chat/reasoning-trace';
import { TurnInspectorDrawer } from '@/components/app/questionnaire/chat/turn-inspector-drawer';

export interface QuestionnaireChatProps {
  /** The session id powering `/questionnaire-sessions/:id/messages` (used by the mic). */
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** The shared stream state, owned by {@link SessionWorkspace}. */
  stream: UseQuestionnaireSessionStreamReturn;
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
  /** Show the attachment affordance (gated server-side on the attachment-input flag). */
  attachmentInputEnabled?: boolean;
  /**
   * Live "watch it think" reasoning placement (demo feature) — `overlay` shows an animated feed
   * while a turn streams then collapses it onto the turn; `inline` shows only the quiet collapsed
   * trace beneath each turn. `undefined`/null = the feature is off (no trace rendered), which is
   * what the page passes when the platform flag or the version toggle is off.
   */
  reasoningPlacement?: ReasoningPlacement | null;
  /**
   * Type the seeded opening turn(s) in (the welcome greeting) instead of snapping them in
   * fully-formed. Replies that arrive *after* mount always type in regardless; this flag only
   * governs the pre-seeded turns, so set it for fresh sessions (alongside `autoStart`) and leave
   * it off on resume so a restored transcript renders its history instantly.
   */
  animateOpening?: boolean;
  className?: string;
}

/**
 * The side-band notices that belong to one assistant turn, rendered inline beneath it. A flagged
 * contradiction (F4.3) gets a tasteful callout — the clearest "the agent is reasoning about your
 * answers" signal; seriousness/support get their bespoke notices; every other code stays a quiet
 * fail-soft line. Attached to the turn (not a transient banner), so they persist as the
 * conversation scrolls on and replay on resume. Renders nothing when the turn raised none.
 */
function TurnNotices({ warnings }: { warnings?: SessionWarning[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {warnings.map((warning, i) =>
        warning.code === 'contradiction' ? (
          <ContradictionNotice key={i} message={warning.message} detail={warning.detail} />
        ) : warning.code === 'seriousness' ? (
          <SeriousnessNotice key={i} message={warning.message} detail={warning.detail} />
        ) : warning.code === 'support' ? (
          <SupportNotice key={i} message={warning.message} />
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
 * The settled (collapsed) reasoning trace for one assistant turn, rendered **above** the reply —
 * directly under the respondent's message it processed, before the agent's reply. The trace is about
 * reading that message and choosing what to ask next, so it belongs there, not below the reply.
 * Shown for BOTH placements' history (overlay collapses to this once the turn settles; inline only
 * ever shows this). Renders nothing when the feature is off (no placement) or the turn had no trace.
 */
function TurnReasoning({
  steps,
  placement,
}: {
  steps?: ReasoningStep[];
  placement?: ReasoningPlacement | null;
}) {
  if (!placement || !steps || steps.length === 0) return null;
  return <ReasoningTrace steps={steps} variant="collapsed" className="mb-2.5" />;
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
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
  onDone,
}: {
  content: string;
  /** Side-band notices to render beneath the reply once it has finished typing in. */
  warnings?: SessionWarning[];
  /** The turn's reasoning trace, rendered collapsed beneath the reply once it has typed in. */
  reasoning?: ReasoningStep[];
  reasoningPlacement?: ReasoningPlacement | null;
  /** Fired once when the message has fully typed in (used to chain the opening turns). */
  onDone?: () => void;
}) {
  const [shown, setShown] = useState(0);
  // Keep the latest callback without re-running the typing effect (which would restart the timer).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
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
  }, [content]);

  const done = shown >= content.length;
  return (
    <AssistantTurn>
      {/* Reasoning sits ABOVE the reply — directly under the respondent's message it processed —
          and shows as the reply types, so it reads as "here's what I worked out, now my question." */}
      <TurnReasoning steps={reasoning} placement={reasoningPlacement} />
      {done ? (
        <>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <Markdown>{content}</Markdown>
          </div>
          {/* The notices only land once the reply has fully typed in — they read as the agent's
              considered aside, not something racing the message itself. */}
          <TurnNotices warnings={warnings} />
        </>
      ) : (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
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
  beatMs,
  onDone,
}: {
  content: string;
  /** Side-band notices to render beneath the reply once it has finished typing in. */
  warnings?: SessionWarning[];
  /** The turn's reasoning trace, rendered collapsed beneath the reply once it has typed in. */
  reasoning?: ReasoningStep[];
  reasoningPlacement?: ReasoningPlacement | null;
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
        <ThinkingIndicator />
      </AssistantTurn>
    );
  }
  return (
    <TypewriterAssistantTurn
      content={content}
      warnings={warnings}
      reasoning={reasoning}
      reasoningPlacement={reasoningPlacement}
      onDone={onDone}
    />
  );
}

export function QuestionnaireChat({
  sessionId,
  accessToken,
  stream,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  reasoningPlacement,
  animateOpening = false,
  className,
}: QuestionnaireChatProps) {
  const {
    turns,
    streaming,
    streamingReasoning,
    inspectorTurns,
    status,
    error,
    canSend,
    sendMessage,
    dismissError,
  } = stream;
  // Overlay placement shows the live feed in place of the thinking dots; inline keeps the plain
  // dots and only reveals the (collapsed) trace once the turn settles.
  const showLiveOverlay = reasoningPlacement === 'overlay' && streamingReasoning.length > 0;

  const [input, setInput] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Attachment state is owned by the platform <AttachmentPickerButton> (the useAttachments
  // hook): base64 encoding, per-file + combined size caps, MIME gating, and object-URL
  // cleanup. We mirror its current payload + entries here for sending + the thumbnail strip,
  // and reset it after a send via the imperative controls.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachEntries, setAttachEntries] = useState<AttachmentEntry[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachControls = useRef<{ clear: () => void; remove: (id: string) => void } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The number of seeded turns present at mount (a resumed transcript's history). On a resumed
  // session (`animateOpening` off) these render instantly; the reveal queue starts just past them.
  const [openingTurnCount] = useState(() => turns.length);
  // Reveal queue: assistant turns are shown STRICTLY one at a time. `revealCursor` is the index of
  // the turn currently being revealed — turns before it are settled (typed/instant), the turn at
  // it is active (beat → type), turns after it stay hidden until the queue reaches them. The active
  // turn's `onDone` advances the cursor. This serialises even the opening burst, where two
  // assistant messages (greeting + first question) arrive with no user turn between them and would
  // otherwise type over each other. On a resumed session, history is already settled, so the queue
  // begins past it.
  const [revealCursor, setRevealCursor] = useState(() => (animateOpening ? 0 : turns.length));

  // The cursor only ever rests on an assistant turn (the one being typed). A user turn at the
  // cursor is the respondent's own message — already on screen — so step straight over it.
  useEffect(() => {
    if (turns[revealCursor]?.role === 'user') setRevealCursor((c) => c + 1);
  }, [revealCursor, turns]);

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

  // Auto-grow the composer with its content. Reset to auto so it can shrink when text
  // is deleted, then size to the scroll height — `max-h-40` caps growth and flips the
  // textarea to scrolling once the content exceeds the cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Refocus the composer when a turn finishes — the textarea is disabled while a reply streams,
  // so we put the cursor back the moment it re-enables, ready for the next answer without a click.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming && canSend) {
      textareaRef.current?.focus();
    }
    wasStreamingRef.current = streaming;
  }, [streaming, canSend]);

  const handleSend = () => {
    if (!canSend || input.trim().length === 0) return;
    setVoiceError(null);
    void sendMessage(input, attachments.length > 0 ? attachments : undefined);
    setInput('');
    attachControls.current?.clear();
    setAttachError(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isTerminal =
    status === 'cost_capped' ||
    status === 'not_active' ||
    status === 'completed' ||
    status === 'expired';

  return (
    <div className={cn('bg-card flex h-full min-h-0 flex-col rounded-xl border', className)}>
      {/* Preview Turn Inspector (admin only): a fixed right-edge console, mounted only once the
          server has emitted inspector frames — which it does solely for a preview session with the
          toggle on, so it never appears for a real respondent. */}
      {inspectorTurns.length > 0 && <TurnInspectorDrawer turns={inspectorTurns} />}
      {/* Transcript */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
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
                    <Markdown>{turn.content}</Markdown>
                  </div>
                  {/* Replayed transcript: its persisted notices render beneath the turn. */}
                  <TurnNotices warnings={turn.warnings} />
                </AssistantTurn>
              );
            }

            // The active turn (and already-typed ones, which re-render settled): beat → type, and
            // advance the queue on completion. A settled turn passes beat 0 and a no-op onDone.
            const isActive = i === revealCursor;
            return (
              <RevealedAssistantTurn
                key={i}
                content={turn.content}
                warnings={turn.warnings}
                reasoning={turn.reasoning}
                reasoningPlacement={reasoningPlacement}
                beatMs={isActive ? beatForTurn(i) : 0}
                onDone={isActive ? () => setRevealCursor((c) => Math.max(c, i + 1)) : () => {}}
              />
            );
          })}

          {/* Awaiting a reply — a calm "thinking" indicator. The reply then types itself in once
              it lands as a committed turn (above). Only shown once the reveal queue has caught up
              to every committed turn, so it never doubles with an active turn's own beat/typing
              while earlier opening messages are still revealing. */}
          {streaming && revealCursor >= turns.length && (
            <AssistantTurn>
              {/* Overlay placement: once the reasoning frame lands, the live feed replaces the dots
                  so the respondent watches the agent work; until then (and for inline) the calm
                  thinking dots stand in. */}
              {showLiveOverlay ? (
                <ReasoningTrace variant="live" steps={streamingReasoning} />
              ) : (
                <ThinkingIndicator />
              )}
            </AssistantTurn>
          )}

          {/* Blocking / error state */}
          {error && (
            <ChatErrorPanel
              status={status}
              error={error}
              onDismiss={status === 'error' ? dismissError : undefined}
            />
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      {!isTerminal && (
        <div className="border-t px-4 py-3 sm:px-6">
          <div className="mx-auto max-w-2xl">
            {/* Pending attachments — strip above the input row, driven by the picker hook. */}
            {attachmentInputEnabled && (
              <AttachmentThumbnailStrip
                attachments={attachEntries}
                remove={(id) => attachControls.current?.remove(id)}
                className="mb-2"
              />
            )}
            <div className="flex items-end gap-2">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!canSend}
                rows={1}
                placeholder={streaming ? 'Waiting for a reply…' : 'Type your answer…'}
                aria-label="Your answer"
                className="max-h-40 min-h-[2.5rem] resize-none overflow-y-auto"
              />
              {attachmentInputEnabled && (
                <AttachmentPickerButton
                  inlineThumbnails={false}
                  disabled={!canSend}
                  pasteTarget={textareaRef}
                  controlsRef={attachControls}
                  onAttachmentsChange={setAttachments}
                  onEntriesChange={setAttachEntries}
                  onError={setAttachError}
                  // Match the Send button's height (h-9) — the picker defaults to size="sm" (h-8).
                  className="h-9"
                />
              )}
              {voiceInputEnabled && (
                <MicButton
                  agentId={sessionId}
                  endpoint={API.APP.QUESTIONNAIRE_SESSIONS.transcribe(sessionId)}
                  disabled={!canSend}
                  // Match the Send button's height (h-9) — the mic defaults to size="sm" (h-8).
                  className="h-9"
                  extraHeaders={accessToken ? { 'X-Session-Token': accessToken } : undefined}
                  onTranscript={(text) => {
                    setVoiceError(null);
                    setInput((cur) => (cur ? `${cur.trimEnd()} ${text}` : text));
                  }}
                  onError={(message) => setVoiceError(message)}
                />
              )}
              <Button
                type="button"
                onClick={handleSend}
                disabled={!canSend || input.trim().length === 0}
                aria-label="Send"
                className="shrink-0 text-white"
                // The CTA gradient var resolves to a brand gradient (ctaColor→ctaColorEnd)
                // when set, else the solid CTA colour; a soft brand-tinted glow gives the
                // pill the lift the email can't. Both fall back to the platform primary.
                style={{
                  background: 'var(--app-cta-gradient, var(--app-cta-color, var(--color-primary)))',
                  boxShadow: '0 8px 18px -8px var(--app-cta-color, var(--color-primary))',
                }}
              >
                <SendHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            {voiceError && (
              <p className="text-destructive mt-1.5 text-xs" role="alert">
                {voiceError}
              </p>
            )}
            {attachError && (
              <p className="text-destructive mt-1.5 text-xs" role="alert">
                {attachError}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
