'use client';

/**
 * ChatComposer — where the respondent writes: the input, the voice and attachment affordances, and
 * send.
 *
 * Split out of `QuestionnaireChat` when `conversation` became two slots (`transcript` +
 * `composer`), so a layout may place it somewhere other than directly beneath the conversation —
 * Broadsheet puts it in a margin beside a document-shaped transcript, where it stays put while the
 * conversation scrolls. Classic and Focus stack the two back together via `ConversationFrame`.
 *
 * ## Two forms, and the layout says which
 *
 * **Quiet** (`prominent` unset — Classic, Focus) is a single line: the field, then the attachment,
 * mic and Send buttons beside it. It starts one line tall and auto-grows to a cap, so an empty
 * composer costs the conversation above it almost nothing — which is the point, because on these
 * layouts a scrolling transcript is pressing down on the box and competing for the same fixed
 * viewport. `ConversationFrame` has already drawn a card round the conversation and a hairline seam
 * above this, so the composer adds no surface of its own.
 *
 * **Prominent** (`prominent` set — Broadsheet, Horizon) is one box: the field and its controls
 * share a bordered, rounded surface with the controls INSIDE it along the bottom edge, opening at
 * prose height. A brand-tinted resting border and a soft brand glow deepen to a full ring on focus;
 * every colour resolves from `--app-*` with a platform fallback, so it wears the client's brand
 * instead of competing with it.
 *
 * The two layouts that ask for it arrive from different directions. Broadsheet holds the composer
 * in an otherwise empty margin, where a bare field would float unfindable and a row of buttons
 * beside a rail-width field leaves the mic and Send marooned at opposite ends of a mostly-empty
 * line. Horizon puts one question on a centred stage with everything else folded away, so the
 * answer box is the only other thing on screen with open space above it — and a one-line field in
 * that expanse reads as an afterthought when the layout's whole argument is *this question, and
 * your answer to it*.
 *
 * Neither form is the default the other should inherit. The box shipped applied everywhere, which
 * gave Classic a four-line bordered field under a rule and a conversation that wanted the room; the
 * correction then took it off Horizon, which is the one stacked layout that had earned it.
 *
 * Either way the OUTER edge carries nothing — no padding, no margin, no border — because everything
 * outside the composer belongs to the arrangement. The seam above and the breathing room around it
 * are right when it is stacked in the conversation card and wrong when it stands alone in a rail;
 * `ConversationFrame` supplies them for the layouts that stack, Broadsheet supplies neither, and
 * its box aligns exactly with the transcript card.
 *
 * `fillHeight` (from the layout's `placements.composer.fills`) lets a prominent box become its
 * whole column, which is what Broadsheet's margin gives it and Horizon's stage deliberately does
 * not.
 *
 * Everything the composer needs to know about the conversation's timing comes from
 * {@link useConversation}: `composerReady` is the gate that keeps every input affordance shut until
 * BOTH the HTTP stream has closed AND the transcript's reveal queue has finished typing the reply
 * in. Deriving that here would let the box re-open mid-reveal and invite an answer to a question
 * the respondent had not finished reading.
 *
 * A `<div>` (not a `<form>`) hosts the controls to stay safe if ever embedded. The send button
 * picks up `--app-cta-gradient` / `--app-cta-color` when the client's theme sets them, with
 * platform-default fallbacks, so theming activates with no change here.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';

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
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import { useConversation } from '@/components/app/questionnaire/chat/conversation-context';

export interface ChatComposerProps {
  /** The session id the mic's transcription endpoint is keyed on. */
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** The shared stream state, owned by `SessionWorkspace`. */
  stream: UseQuestionnaireSessionStreamReturn;
  /** Show the voice-input affordance (gated server-side on the voice flag). */
  voiceInputEnabled?: boolean;
  /** Show the attachment affordance (gated server-side on the attachment-input flag). */
  attachmentInputEnabled?: boolean;
  /**
   * Take the full height of whatever the layout put this in, rather than sizing to the text.
   *
   * Set from the layout's `placements.composer.fills` declaration. Broadsheet turns it on: its
   * margin is a full-height column with nothing else in it, so the answer box becomes the column
   * and the respondent gets real room to write. Everywhere else the box keeps its floor and grows
   * with what is typed, up to a cap.
   */
  fillHeight?: boolean;
  /**
   * Draw the composer's own surface — a bordered box, opening at prose height, with the controls
   * inside along its bottom edge — rather than a field with its controls on the line beside it.
   *
   * Set from the layout's `placements.composer.prominent` declaration. Broadsheet and Horizon turn
   * it on (a bare margin that needs edges; a one-question stage where the answer box is the only
   * other thing on screen). Classic and Focus leave it off: there a scrolling transcript is
   * competing for the same viewport, and an empty box holding four lines would be taking them from
   * the conversation.
   */
  prominent?: boolean;
  className?: string;
}

export function ChatComposer({
  sessionId,
  accessToken,
  stream,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  fillHeight = false,
  prominent = false,
  className,
}: ChatComposerProps) {
  const { sendMessage } = stream;
  const { composerReady, composerHint, stageLabel } = useConversation();

  const [input, setInput] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Below Tailwind `sm` the full voice placeholder ("Speak your thoughts with the mic…")
  // truncates mid-word, so fall back to the concise prompt on small screens.
  const isMobile = useMediaQuery('(max-width: 639px)');
  // Attachment state is owned by the platform <AttachmentPickerButton> (the useAttachments
  // hook): base64 encoding, per-file + combined size caps, MIME gating, and object-URL
  // cleanup. We mirror its current payload + entries here for sending + the thumbnail strip,
  // and reset it after a send via the imperative controls.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachEntries, setAttachEntries] = useState<AttachmentEntry[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachControls = useRef<{ clear: () => void; remove: (id: string) => void } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Nothing to send: the box is empty, or it is being held shut. Drives the CTA's whole look. */
  const canSend = composerReady && input.trim().length > 0;

  // Auto-grow the composer with its content. Reset to auto so it can shrink when text is deleted,
  // then size to the scroll height — the max-height caps growth and flips the textarea to
  // scrolling once the content exceeds the cap.
  //
  // Skipped entirely when the box is filling its column: there the height comes from the flex
  // layout, and writing an inline `height` on every keystroke would fight it.
  useEffect(() => {
    if (fillHeight) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input, fillHeight]);

  // Refocus the composer the moment it re-opens — it's disabled while a reply streams AND while the
  // reveal queue types that reply in, so we put the cursor back once both have settled, ready for
  // the next answer without a click. Keyed on `composerReady` (not bare `streaming`) so focus lands
  // when the queue finishes revealing, not the instant the stream closes mid-typewriter.
  const wasComposerBlockedRef = useRef(false);
  useEffect(() => {
    if (wasComposerBlockedRef.current && composerReady) {
      textareaRef.current?.focus();
    }
    wasComposerBlockedRef.current = !composerReady;
  }, [composerReady]);

  const handleSend = () => {
    if (!composerReady || input.trim().length === 0) return;
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

  /* ── The controls ─────────────────────────────────────────────────────────────────────────────
     Built once and placed by whichever form is rendering: inside the box on its bottom edge when
     prominent, on the line beside the field when quiet. Identical behaviour either way — only the
     chrome differs. */
  const attachmentButton = attachmentInputEnabled ? (
    <AttachmentPickerButton
      inlineThumbnails={false}
      disabled={!composerReady}
      pasteTarget={textareaRef}
      controlsRef={attachControls}
      onAttachmentsChange={setAttachments}
      onEntriesChange={setAttachEntries}
      onError={setAttachError}
      // Match the Send button's height (h-9) — the picker defaults to size="sm" (h-8). Chrome-free
      // inside the box, where the box is the surface; the default outline stands on a stacked line.
      className={cn('h-9', prominent && 'w-9 border-transparent bg-transparent shadow-none')}
    />
  ) : null;

  const micButton = voiceInputEnabled ? (
    <MicButton
      agentId={sessionId}
      endpoint={API.APP.QUESTIONNAIRE_SESSIONS.transcribe(sessionId)}
      disabled={!composerReady}
      className={cn('h-9', prominent && 'w-9')}
      // Quiet, not filled. The mic used to carry the solid CTA colour so it read as a "press me"
      // affordance — right when it sat alone, wrong now it is one of three buttons in a cluster:
      // two filled brand controls compete, and with Send greyed out on an empty box the mic became
      // the loudest thing on the page. Brand ink on a transparent ground keeps it clearly available
      // and clearly secondary. The red recording / transcribing states are untouched.
      // No `color-mix()` in an arbitrary class here either — `hover:bg-accent` is an ordinary token
      // that cannot fail to parse, and the brand shows in the ink.
      idleClassName="hover:bg-accent border-transparent bg-transparent text-[var(--app-accent-color,var(--color-primary))] shadow-none hover:text-[var(--app-accent-color,var(--color-primary))]"
      extraHeaders={accessToken ? { 'X-Session-Token': accessToken } : undefined}
      onTranscript={(text) => {
        setVoiceError(null);
        setInput((cur) => (cur ? `${cur.trimEnd()} ${text}` : text));
      }}
      onError={(message) => setVoiceError(message)}
    />
  ) : null;

  const sendButton = (
    <Button
      type="button"
      size="icon"
      onClick={handleSend}
      disabled={!canSend}
      aria-label="Send"
      className={cn(
        'h-9 w-9 shrink-0 rounded-xl transition-[transform,box-shadow,background-color] duration-150',
        canSend
          ? 'text-[var(--app-on-cta,#fff)] hover:brightness-105 active:scale-95'
          : // A neutral disabled state, NOT a pale wash of the brand colour. The washed version read
            // as a broken button rather than an unavailable one — and it is unavailable most of the
            // time, since an empty box cannot be sent.
            'bg-muted text-muted-foreground/60 shadow-none'
      )}
      // Inline because the gradient resolves from a custom property (ctaColor→ctaColorEnd when the
      // client sets one, else the solid CTA colour, else the platform primary) — and it is dropped
      // entirely when disabled so no rule has to fight it.
      style={
        canSend
          ? {
              background: 'var(--app-cta-gradient, var(--app-cta-color, var(--color-primary)))',
              boxShadow: '0 6px 16px -8px var(--app-cta-color, var(--color-primary))',
            }
          : undefined
      }
    >
      <SendHorizontal className="h-4 w-4" aria-hidden="true" />
    </Button>
  );

  /* Quiet keyboard hint. It teaches the one interaction people get wrong (Enter sends; they expect
     a newline). Dropped on narrow surfaces, where the space is genuinely needed. */
  const keyboardHint = (
    <span className="text-muted-foreground/70 hidden text-[0.6875rem] leading-none select-none sm:inline">
      <kbd className="font-sans font-medium">Enter</kbd> to send ·{' '}
      <kbd className="font-sans font-medium">Shift</kbd>+
      <kbd className="font-sans font-medium">Enter</kbd> for a new line
    </span>
  );

  const textarea = (
    <Textarea
      ref={textareaRef}
      value={input}
      onChange={(e) => setInput(e.target.value)}
      onKeyDown={handleKeyDown}
      disabled={!composerReady}
      rows={1}
      placeholder={
        !composerReady
          ? // The live stage when there is one. A placeholder is not announced, so it can change
            // as often as the server reports without making the a11y tree chatty — which is why
            // the `role="status"` line below deliberately keeps the stable copy instead.
            (stageLabel ?? composerHint)
          : voiceInputEnabled && !isMobile
            ? 'Speak your thoughts with the mic, or type…'
            : 'Share your thoughts…'
      }
      aria-label="Your answer"
      className={cn(
        'resize-none overflow-y-auto',
        prominent
          ? cn(
              // Chrome-free: the box around it owns the border, background, shadow and focus ring,
              // so the field contributes none of them and there is one rectangle, not two.
              'w-full border-0 bg-transparent px-4 pt-3.5 pb-0 shadow-none',
              // Filling: the flex column owns the height (`flex-1` beats the inline height the
              // auto-grow effect would otherwise write, which is why that effect is skipped).
              // Otherwise: a floor to look like it expects prose, and a cap before it scrolls.
              fillHeight ? 'min-h-0 flex-1' : 'max-h-56 min-h-[6.5rem]'
            )
          : // Quiet: one line to start, growing with what is typed up to a cap. `min-h` is a floor,
            // not a starting size — the auto-grow effect writes an inline `height` on every
            // keystroke and CSS `min-height` still wins over it, which is why `rows` cannot do this
            // job. Starting small is the whole point here: the conversation above is competing for
            // the same viewport, and an empty answer box should not be holding four lines of it.
            'max-h-40 min-h-[2.5rem]'
      )}
    />
  );

  return (
    <div className={cn(fillHeight && 'flex h-full min-h-0 flex-col', className)}>
      {/* Same measure as the transcript (not a fixed 2xl) so the two stay exactly aligned at every
          text size and viewport step when a layout stacks them. */}
      <div className={cn('cq-chat-measure', fillHeight && 'flex min-h-0 flex-1 flex-col')}>
        {/* Pending attachments — strip above the input row, driven by the picker hook. */}
        {attachmentInputEnabled && (
          <AttachmentThumbnailStrip
            attachments={attachEntries}
            remove={(id) => attachControls.current?.remove(id)}
            className="mb-2"
          />
        )}
        {/* Explicit wait cue while the composer is held closed. Shown visually in the disabled
            input's placeholder (above); this copy is visually hidden (`sr-only`) but stays in
            the a11y tree so its `role="status"` still announces the change to assistive tech (a
            placeholder isn't announced). Hiding it removes the duplicated on-screen line.

            It announces `composerHint`, NOT the live stage label: the transcript's `TurnProgress`
            is already a polite live region on the same wait, and pointing both at a label that
            changes once per stage would have every stage read out twice. */}
        {!composerReady && (
          <div className="sr-only">
            <ThinkingIndicator message={composerHint} />
          </div>
        )}

        {prominent ? (
          /* ── Prominent: the answer box ─────────────────────────────────────────────────────────
             ONE surface, because the layout gave this slot room and expects it to be present in it.
             The field and its controls share a single bordered, rounded box with the controls
             INSIDE it along the bottom edge — beside a rail-width field, or under a stage with
             open space above it, a separate row of buttons leaves the mic and Send marooned at
             opposite ends of a mostly-empty line.

             It is also, deliberately, the loudest quiet thing on the surface. This is the one place
             a respondent acts, and on both layouts that ask for this form there is nothing around
             it to say so. Hence a brand-tinted resting border and a soft brand glow — visible
             enough to find at a glance, calm enough to sit under a twenty-minute conversation —
             deepening to a full ring on focus. Every colour is `--app-*` with a platform fallback,
             so it takes the client's brand rather than competing with it. */
          <div
            className={cn(
              // `.cq-composer` (globals.css) paints the surface: the brand-tinted resting border,
              // the focus ring, and the muted held-shut state. It lives there rather than in
              // arbitrary classes here because every one of those colours is a `color-mix()` over a
              // custom property, and one that fails to parse inside a class name fails silently —
              // which is how the focus state ended up as the browser's own blue outline.
              'cq-composer relative rounded-xl border bg-[var(--color-background)]',
              fillHeight && 'flex min-h-0 flex-1 flex-col'
            )}
          >
            {textarea}
            {/* Controls, inside the box on its bottom edge. `ml-auto` on the cluster keeps them
                together at the trailing end however many of them config actually enables — a spacer
                or `justify-between` would spread two buttons across the width the moment one was
                turned off, which is precisely the marooning this replaces. */}
            <div className="flex items-center gap-2 px-3 pb-2.5">
              {keyboardHint}
              <div className="ml-auto flex items-center gap-1">
                {attachmentButton}
                {micButton}
                {sendButton}
              </div>
            </div>
          </div>
        ) : (
          /* ── Quiet: a field and its controls, on one line ─────────────────────────────────────
             Classic and Focus: `ConversationFrame` has already drawn the card and the hairline seam
             above this, and a scrolling transcript is pressing down from above, so the composer adds
             no surface of its own and no four-line floor — both would be taking room from the
             conversation it sits under. `items-end` keeps the buttons on the field's bottom edge as
             it grows. */
          <>
            <div className="flex items-end gap-2">
              {textarea}
              {attachmentButton}
              {micButton}
              {sendButton}
            </div>
            {/* Below the row rather than in it: on a stacked line the field takes the width, and a
                hint competing for it would push the controls off. */}
            <div className="mt-1.5 leading-none">{keyboardHint}</div>
          </>
        )}

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
  );
}
