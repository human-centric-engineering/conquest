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
 * Brand colours come from CSS custom properties (`--app-accent-color`, `--app-cta-color`)
 * with platform-default fallbacks, so the F7.1-PR4 theming layer activates with no change
 * here. A `<div>` (not a `<form>`) hosts the composer to stay safe if ever embedded.
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
import { ChatErrorPanel } from '@/components/app/questionnaire/chat/chat-error-panel';
import { ContradictionNotice } from '@/components/app/questionnaire/chat/contradiction-notice';

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
  className?: string;
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
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: 'var(--app-accent-color, var(--color-primary))' }}
      />
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
  );
}

export function QuestionnaireChat({
  sessionId,
  accessToken,
  stream,
  voiceInputEnabled = false,
  attachmentInputEnabled = false,
  className,
}: QuestionnaireChatProps) {
  const {
    turns,
    streaming,
    streamingText,
    status,
    warning,
    error,
    canSend,
    sendMessage,
    dismissError,
  } = stream;

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

  // Keep the latest turn / streaming tail in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, streamingText, streaming]);

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
      {/* Transcript */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <UserBubble key={i} content={turn.content} />
            ) : (
              <AssistantTurn key={i}>
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <Markdown>{turn.content}</Markdown>
                </div>
              </AssistantTurn>
            )
          )}

          {/* In-flight assistant turn */}
          {streaming && (
            <AssistantTurn>
              {streamingText.length === 0 ? (
                <ThinkingIndicator />
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {streamingText}
                  <span className="terminal-caret" aria-hidden="true">
                    ▋
                  </span>
                </p>
              )}
            </AssistantTurn>
          )}

          {/* Side-band notice. A flagged contradiction (F4.3) gets a tasteful callout —
              the clearest "the agent is reasoning about your answers" signal; every other
              warning stays a quiet fail-soft line. */}
          {warning &&
            (warning.code === 'contradiction' ? (
              <ContradictionNotice message={warning.message} />
            ) : (
              <div
                role="status"
                className="border-l-2 pl-3 text-xs"
                style={{ borderColor: 'var(--app-accent-color, var(--color-primary))' }}
              >
                <span className="text-muted-foreground">{warning.message}</span>
              </div>
            ))}

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
                className="max-h-40 min-h-[2.5rem] resize-none"
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
                />
              )}
              {voiceInputEnabled && (
                <MicButton
                  agentId={sessionId}
                  endpoint={API.APP.QUESTIONNAIRE_SESSIONS.transcribe(sessionId)}
                  disabled={!canSend}
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
                style={{ backgroundColor: 'var(--app-cta-color, var(--color-primary))' }}
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
