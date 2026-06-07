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
import { Paperclip, SendHorizontal, X } from 'lucide-react';
import Markdown from 'react-markdown';

import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import { MicButton } from '@/components/admin/orchestration/chat/mic-button';
import type {
  MessageAttachment,
  UseQuestionnaireSessionStreamReturn,
} from '@/lib/hooks/use-questionnaire-session-stream';
import { ChatErrorPanel } from '@/components/app/questionnaire/chat/chat-error-panel';

/** Media types the respondent may attach — mirrors the platform `chatAttachmentSchema`. */
const ATTACHMENT_ACCEPT =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_ATTACHMENTS = 10;
/** ~5 MB per file — matches the server's per-attachment cap before base64 expansion. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Read a File into the base64 `{ name, mediaType, data }` the `/messages` route accepts. */
function readAttachment(file: File): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // Strip the `data:<mime>;base64,` prefix — the schema wants raw base64.
      const data = result.slice(result.indexOf(',') + 1);
      resolve({ name: file.name, mediaType: file.type, data });
    };
    reader.readAsDataURL(file);
  });
}

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
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    setAttachments([]);
    setAttachError(null);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachError(null);
    const room = MAX_ATTACHMENTS - attachments.length;
    const picked = Array.from(files).slice(0, room);
    if (Array.from(files).length > room) {
      setAttachError(`At most ${MAX_ATTACHMENTS} files per message.`);
    }
    try {
      const tooBig = picked.find((f) => f.size > MAX_ATTACHMENT_BYTES);
      if (tooBig) {
        setAttachError(`"${tooBig.name}" is over the 5 MB limit.`);
        return;
      }
      const read = await Promise.all(picked.map(readAttachment));
      setAttachments((prev) => [...prev, ...read]);
    } catch {
      setAttachError('Could not read that file. Try another.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
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

          {/* Side-band contradiction / fail-soft notice */}
          {warning && (
            <div
              role="status"
              className="border-l-2 pl-3 text-xs"
              style={{ borderColor: 'var(--app-accent-color, var(--color-primary))' }}
            >
              <span className="text-muted-foreground">{warning.message}</span>
            </div>
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
            {/* Pending attachment chips */}
            {attachmentInputEnabled && attachments.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-2">
                {attachments.map((att, i) => (
                  <li
                    key={`${att.name}-${i}`}
                    className="bg-muted flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                  >
                    <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="max-w-[12rem] truncate">{att.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      disabled={!canSend}
                      aria-label={`Remove ${att.name}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-end gap-2">
              <Textarea
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
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept={ATTACHMENT_ACCEPT}
                    className="hidden"
                    onChange={(e) => void handleFiles(e.target.files)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => fileRef.current?.click()}
                    disabled={!canSend || attachments.length >= MAX_ATTACHMENTS}
                    aria-label="Attach a file"
                    className="shrink-0"
                  >
                    <Paperclip className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </>
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
