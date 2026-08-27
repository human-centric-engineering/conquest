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
 * ## One box
 *
 * The field and its controls share a single bordered, rounded surface, with the controls INSIDE it
 * along the bottom edge. The earlier arrangement — a bordered field, then a separate row of buttons
 * beneath it, inside whatever card the layout supplied — nested three rectangles and, at margin
 * width, left the mic and Send marooned at opposite ends of a mostly-empty row.
 *
 * The surface is the composer's own; the OUTER edge carries nothing at all — no padding, no
 * margin, no border — because everything outside the box belongs to the arrangement. The seam
 * above it and the breathing room around it are both right when the composer is stacked inside the
 * conversation card, and both wrong when it stands alone in a rail: they inset it from the rail's
 * edges and knock its top and bottom out of line with the document beside it. `ConversationFrame`
 * supplies them for the layouts that stack; Broadsheet supplies neither, and its box aligns exactly
 * with the transcript card.
 *
 * Findability is deliberate, not decoration. This is the one place a respondent acts, and in a
 * document layout it sits in a margin with nothing else to mark it: hence a brand-tinted resting
 * border and a soft brand glow that deepen to a full ring on focus. Every colour resolves from
 * `--app-*` with a platform fallback, so it wears the client's brand instead of competing with it.
 *
 * `fillHeight` (from the layout's `placements.composer.fills`) lets the box become its whole
 * column, which is what Broadsheet's margin gives it.
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
  className?: string;
}

export function ChatComposer({
  sessionId,
  accessToken,
  stream,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  fillHeight = false,
  className,
}: ChatComposerProps) {
  const { sendMessage } = stream;
  const { composerReady, composerHint } = useConversation();

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
            input's placeholder (below); this copy is visually hidden (`sr-only`) but stays in
            the a11y tree so its `role="status"` still announces the change to assistive tech (a
            placeholder isn't announced). Hiding it removes the duplicated on-screen line. */}
        {!composerReady && (
          <div className="sr-only">
            <ThinkingIndicator message={composerHint} />
          </div>
        )}
        {/* ── The answer box ───────────────────────────────────────────────────────────────────
            ONE surface: the field and its controls share a single bordered, rounded box, and the
            controls sit INSIDE it along the bottom edge. Previously the field was a bordered box
            and the controls a separate row beneath it, inside whatever card the layout supplied —
            three nested rectangles, and in a margin-width rail the mic and send ended up marooned
            at opposite ends of a mostly-empty row.

            It is also, deliberately, the loudest quiet thing on the surface. This is the one place
            a respondent acts; on a document-shaped layout it sits in a margin with nothing around
            it to say so. Hence a brand-tinted resting border and a soft brand glow — visible enough
            to find at a glance, calm enough to sit under a twenty-minute conversation — deepening
            to a full ring on focus. Every colour is `--app-*` with a platform fallback, so it takes
            the client's brand rather than competing with it. */}
        <div
          className={cn(
            // `.cq-composer` (globals.css) paints the surface: the brand-tinted resting border, the
            // focus ring, and the muted held-shut state. It lives there rather than in arbitrary
            // classes here because every one of those colours is a `color-mix()` over a custom
            // property, and one that fails to parse inside a class name fails silently — which is
            // how the focus state ended up as the browser's own blue outline.
            'cq-composer relative rounded-xl border bg-[var(--color-background)]',
            fillHeight && 'flex min-h-0 flex-1 flex-col'
          )}
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!composerReady}
            rows={1}
            placeholder={
              !composerReady
                ? composerHint
                : voiceInputEnabled && !isMobile
                  ? 'Speak your thoughts with the mic, or type…'
                  : 'Share your thoughts…'
            }
            aria-label="Your answer"
            // The `min-h` is a floor, not a starting size: the auto-grow effect above writes an
            // inline `height` on every keystroke, and CSS `min-height` still wins over it — which
            // is why `rows` cannot do this job (an empty textarea's `scrollHeight` is one line
            // whatever `rows` says, so the effect collapses it, which is how this ended up one line
            // tall with a clipped two-line placeholder). Four lines, because a questionnaire answer
            // is prose and the box should look like it expects some.
            //
            // Chrome-free: the surface above owns the border, background, shadow and focus ring, so
            // the field itself contributes none of them and there is one rectangle, not two.
            className={cn(
              'w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pt-3.5 pb-0 shadow-none',
              // Filling: the flex row owns the height (`flex-1` beats the inline height the
              // auto-grow effect would otherwise write, which is why that effect is skipped).
              // Otherwise: a floor to look like it expects prose, and a cap before it scrolls.
              fillHeight ? 'min-h-0 flex-1' : 'max-h-56 min-h-[6.5rem]'
            )}
          />
          {/* Controls, inside the box on its bottom edge. `ml-auto` on the cluster keeps them
              together at the trailing end however many of them config actually enables — a spacer
              or `justify-between` would spread two buttons across the width the moment one was
              turned off, which is precisely the marooning this replaces. */}
          <div className="flex items-center gap-2 px-3 pb-2.5">
            {/* Quiet keyboard hint. It earns the left-hand space that would otherwise be a gap, and
                it teaches the one interaction people get wrong (Enter sends; they expect a
                newline). Dropped on narrow surfaces, where the space is genuinely needed. */}
            <span className="text-muted-foreground/70 hidden text-[0.6875rem] leading-none select-none sm:inline">
              <kbd className="font-sans font-medium">Enter</kbd> to send ·{' '}
              <kbd className="font-sans font-medium">Shift</kbd>+
              <kbd className="font-sans font-medium">Enter</kbd> for a new line
            </span>
            <div className="ml-auto flex items-center gap-1">
              {attachmentInputEnabled && (
                <AttachmentPickerButton
                  inlineThumbnails={false}
                  disabled={!composerReady}
                  pasteTarget={textareaRef}
                  controlsRef={attachControls}
                  onAttachmentsChange={setAttachments}
                  onEntriesChange={setAttachEntries}
                  onError={setAttachError}
                  className="h-9 w-9 border-transparent bg-transparent shadow-none"
                />
              )}
              {voiceInputEnabled && (
                <MicButton
                  agentId={sessionId}
                  endpoint={API.APP.QUESTIONNAIRE_SESSIONS.transcribe(sessionId)}
                  disabled={!composerReady}
                  className="h-9 w-9"
                  // Quiet, not filled. The mic used to carry the solid CTA colour so it read as a
                  // "press me" affordance — right when it sat alone, wrong now it is one of three
                  // buttons in a cluster: two filled brand controls compete, and with Send greyed
                  // out on an empty box the mic became the loudest thing on the page. Brand ink on
                  // a transparent ground keeps it clearly available and clearly secondary. The red
                  // recording / transcribing states are untouched.
                  // No `color-mix()` in an arbitrary class here either — `hover:bg-accent` is an
                  // ordinary token that cannot fail to parse, and the brand shows in the ink.
                  idleClassName="hover:bg-accent border-transparent bg-transparent text-[var(--app-accent-color,var(--color-primary))] shadow-none hover:text-[var(--app-accent-color,var(--color-primary))]"
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
                size="icon"
                onClick={handleSend}
                disabled={!canSend}
                aria-label="Send"
                className={cn(
                  'h-9 w-9 shrink-0 rounded-xl transition-[transform,box-shadow,background-color] duration-150',
                  canSend
                    ? 'text-[var(--app-on-cta,#fff)] hover:brightness-105 active:scale-95'
                    : // A neutral disabled state, NOT a pale wash of the brand colour. The washed
                      // version read as a broken button rather than an unavailable one — and it is
                      // unavailable most of the time, since an empty box cannot be sent.
                      'bg-muted text-muted-foreground/60 shadow-none'
                )}
                // Inline because the gradient resolves from a custom property (ctaColor→ctaColorEnd
                // when the client sets one, else the solid CTA colour, else the platform primary) —
                // and it is dropped entirely when disabled so no rule has to fight it.
                style={
                  canSend
                    ? {
                        background:
                          'var(--app-cta-gradient, var(--app-cta-color, var(--color-primary)))',
                        boxShadow: '0 6px 16px -8px var(--app-cta-color, var(--color-primary))',
                      }
                    : undefined
                }
              >
                <SendHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
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
  );
}
