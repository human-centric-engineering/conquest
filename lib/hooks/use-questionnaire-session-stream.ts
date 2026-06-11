'use client';

/**
 * useQuestionnaireSessionStream — drives the respondent turn loop for the F7.1 chat surface.
 *
 * One hook serves all three access modes. The only runtime difference is the auth header:
 * authenticated sessions ride the cookie (sent via `credentials: 'include'`); the no-login
 * anonymous mode passes the signed `accessToken` as `X-Session-Token`. The hook owns the
 * rendered transcript, the in-flight streaming text (animated via {@link useTypingAnimation}),
 * the side-band warning banner, and the blocking/error status.
 *
 * Turn POSTs are NOT idempotent — a re-send would mint a duplicate turn server-side — so a
 * transport failure mid-stream is surfaced as an error for the respondent to retry manually
 * rather than auto-retried.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts — the SSE contract
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';
import { parseSessionEvent } from '@/lib/app/questionnaire/chat/parse-session-event';
import {
  BLOCKING_STATUSES,
  type ChatErrorState,
  type QuestionnaireChatStatus,
  type QuestionnaireTurn,
  type SessionWarning,
} from '@/lib/app/questionnaire/chat/types';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';

/** A base64-encoded file the respondent attaches to a turn — the platform `ChatAttachment`
 *  shape (`{ name, mediaType, data }`), single-sourced so the composer, the picker hook,
 *  and this sender can't drift. */
export type MessageAttachment = ChatAttachment;

export interface UseQuestionnaireSessionStreamOptions {
  /** The session id (the `:id` in `/questionnaire-sessions/:id/messages`). */
  sessionId: string;
  /**
   * Anonymous no-login token. When set, every request carries it as `X-Session-Token`.
   * Omit for authenticated (cookie) sessions.
   */
  accessToken?: string;
  /** Seed the transcript (e.g. a resume greeting). */
  initialTurns?: QuestionnaireTurn[];
  /** Start in a blocking status (e.g. `not_active` for an already-paused session). */
  initialStatus?: QuestionnaireChatStatus;
  /**
   * Fired once a turn settles cleanly to `idle` (the server has persisted the turn +
   * any answers). NOT fired on error/abort. F7.2 uses this to refetch the answer
   * panel after each turn. Read through a ref, so passing a fresh closure each render
   * does not churn `sendMessage`'s identity.
   */
  onTurnSettled?: () => void;
}

export interface UseQuestionnaireSessionStreamReturn {
  turns: QuestionnaireTurn[];
  /** Whether a turn is currently streaming. */
  streaming: boolean;
  /** The animated assistant text for the in-flight turn (empty until the first delta). */
  streamingText: string;
  status: QuestionnaireChatStatus;
  warning: SessionWarning | null;
  error: ChatErrorState | null;
  /** Whether the composer should accept input. */
  canSend: boolean;
  /** Send a respondent message (with optional attachments) and stream the reply. No-ops when blocked or empty. */
  sendMessage: (text: string, attachments?: MessageAttachment[]) => Promise<void>;
  /**
   * Proactive opening: stream the first question without a respondent message (no user bubble).
   * Fired once on a fresh session by {@link SessionWorkspace}'s `autoStart`. No-ops when blocked.
   */
  kickoff: () => Promise<void>;
  /** Clear a transient error banner. */
  dismissError: () => void;
  /**
   * Push an authoritative session status into the surface — the seam for lifecycle
   * actions (F7.3) that change status server-side: a respondent pause sets `not_active`,
   * resume sets `idle`, submit sets `completed`. Moving to a non-blocking status clears
   * any stale blocking error so the composer re-enables. NOT used for turn flow (that's
   * driven internally by `sendMessage`).
   */
  applyStatus: (status: QuestionnaireChatStatus) => void;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** Map a pre-stream HTTP failure to a status + friendly error. */
function classifyHttpFailure(
  httpStatus: number,
  code: string | undefined,
  message: string | undefined,
  anonymous: boolean
): { status: QuestionnaireChatStatus; error: ChatErrorState } {
  if (httpStatus === 402) {
    return {
      status: 'cost_capped',
      error: {
        code: code ?? 'COST_CAP_REACHED',
        title: "We've reached this conversation's limit",
        message:
          'This session has used its allotted budget. Your responses so far are saved — thank you for your time.',
      },
    };
  }
  if (httpStatus === 409) {
    return {
      status: 'not_active',
      error: {
        code: code ?? 'SESSION_NOT_ACTIVE',
        title: 'This session is no longer active',
        message:
          message ?? 'It may have been paused or completed. Your responses so far are saved.',
      },
    };
  }
  if ((httpStatus === 401 || httpStatus === 403) && anonymous) {
    return {
      status: 'expired',
      error: {
        code: code ?? 'SESSION_TOKEN_INVALID',
        title: 'Your session has expired',
        message: 'Anonymous sessions last 24 hours. Please reload the page to start a new one.',
      },
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    // Authenticated session is no longer valid (cookie revoked or expired). Terminal, not
    // transient: a retry would 401 again, so surface a sign-in prompt rather than leaving the
    // composer enabled in a retry loop that can never succeed.
    return {
      status: 'not_active',
      error: {
        code: code ?? 'SESSION_UNAUTHORIZED',
        title: 'Your session has ended',
        message: 'Please sign in again to continue your questionnaire.',
      },
    };
  }
  if (httpStatus === 429) {
    return {
      status: 'error',
      error: {
        code: code ?? 'RATE_LIMITED',
        title: 'One moment',
        message: "You're sending messages a little fast. Wait a few seconds and try again.",
      },
    };
  }
  return {
    status: 'error',
    error: {
      code: code ?? 'STREAM_ERROR',
      title: 'Something went wrong',
      message: message ?? 'We could not reach the conversation service. Please try again.',
    },
  };
}

/** The error to show when the surface mounts already in a blocking status. */
function defaultBlockingError(status: QuestionnaireChatStatus): ChatErrorState | null {
  switch (status) {
    case 'cost_capped':
      return classifyHttpFailure(402, undefined, undefined, false).error;
    case 'not_active':
      return classifyHttpFailure(409, undefined, undefined, false).error;
    case 'expired':
      return classifyHttpFailure(401, undefined, undefined, true).error;
    default:
      return null;
  }
}

export function useQuestionnaireSessionStream(
  options: UseQuestionnaireSessionStreamOptions
): UseQuestionnaireSessionStreamReturn {
  const { sessionId, accessToken, initialTurns, initialStatus, onTurnSettled } = options;
  const anonymous = Boolean(accessToken);

  // Hold the latest settle callback in a ref so `sendMessage` stays stable even when
  // the caller passes a new closure each render.
  const onTurnSettledRef = useRef(onTurnSettled);
  onTurnSettledRef.current = onTurnSettled;

  const [turns, setTurns] = useState<QuestionnaireTurn[]>(initialTurns ?? []);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<QuestionnaireChatStatus>(initialStatus ?? 'idle');
  const [warning, setWarning] = useState<SessionWarning | null>(null);
  const [error, setError] = useState<ChatErrorState | null>(() =>
    initialStatus ? defaultBlockingError(initialStatus) : null
  );

  const typing = useTypingAnimation({ chunkSize: 4 });
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream on unmount so the reader doesn't setState on a torn-down tree.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  const applyStatus = useCallback((next: QuestionnaireChatStatus) => {
    setStatus(next);
    // Resuming (→ idle/active) clears a stale paused/blocking banner; a terminal status
    // (completed / not_active) keeps its own surface (confirmation / blocking panel).
    if (!BLOCKING_STATUSES.includes(next)) setError(null);
  }, []);

  // Shared streaming core for both a respondent send and the proactive kickoff. `userTurn`
  // is the optimistic respondent bubble to show before streaming (omitted for a kickoff, which
  // carries no respondent message); `body` is the POST payload (`{ message, attachments }` or
  // `{ kickoff: true }`).
  const streamTurn = useCallback(
    async (opts: { body: Record<string, unknown>; userTurn?: string }) => {
      // `BLOCKING_STATUSES` (streaming + the terminal cost-cap / not-active / expired states)
      // is the single source of truth for "no further input is meaningful" — the same set
      // `canSend` is derived from, so the guard and the composer can never disagree.
      if (BLOCKING_STATUSES.includes(status)) return;

      // Optimistic: show the respondent's turn immediately (when present) and clear side-band state.
      if (opts.userTurn !== undefined) {
        setTurns((prev) => [...prev, { role: 'user', content: opts.userTurn as string }]);
      }
      setWarning(null);
      setError(null);
      setStatus('streaming');
      setStreaming(true);
      typing.reset();

      const controller = new AbortController();
      abortRef.current = controller;

      let fullText = '';
      let streamError: ChatErrorState | null = null;

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (accessToken) headers['X-Session-Token'] = accessToken;

        const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.messages(sessionId), {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(opts.body),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let code: string | undefined;
          let message: string | undefined;
          try {
            const body = (await res.json()) as ErrorEnvelope;
            code = body.error?.code;
            message = body.error?.message;
          } catch {
            // Non-JSON error body — fall back to status-based copy.
          }
          const classified = classifyHttpFailure(res.status, code, message, anonymous);
          setStatus(classified.status);
          setError(classified.error);
          setStreaming(false);
          abortRef.current = null;
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const ev = parseSessionEvent(block);
            if (ev) {
              if (ev.type === 'content') {
                fullText += ev.delta;
                typing.appendDelta(ev.delta);
              } else if (ev.type === 'warning') {
                setWarning({ code: ev.code, message: ev.message });
              } else if (ev.type === 'error') {
                streamError = {
                  code: ev.code,
                  title: 'Something went wrong',
                  message: ev.message,
                };
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }

        // Settle the typing buffer and commit the assistant turn (even if the stream ended
        // without an explicit `done` frame, as long as we accumulated text).
        typing.flush();
        if (fullText.length > 0) {
          setTurns((prev) => [...prev, { role: 'assistant', content: fullText }]);
        }

        if (streamError) {
          setStatus('error');
          setError(streamError);
        } else {
          setStatus('idle');
          // The turn (and any answers it captured) is now persisted — let the panel refresh.
          onTurnSettledRef.current?.();
        }
      } catch (err) {
        // Aborted (unmount / navigation) is expected — leave state alone.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
        setError({
          code: 'NETWORK_ERROR',
          title: 'Connection lost',
          message:
            fullText.length > 0
              ? 'The reply was interrupted. Please check your connection and try again.'
              : 'We could not reach the conversation service. Please try again.',
        });
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [sessionId, accessToken, anonymous, status, typing]
  );

  const sendMessage = useCallback(
    async (text: string, attachments?: MessageAttachment[]) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      await streamTurn({
        body: {
          message: trimmed,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
        userTurn: trimmed,
      });
    },
    [streamTurn]
  );

  // Proactive opening: stream the first question with no respondent bubble. The empty-message
  // turn is skipped by the server's `recentMessages` and ignored by the opening phraser.
  const kickoff = useCallback(async () => {
    await streamTurn({ body: { kickoff: true } });
  }, [streamTurn]);

  // The composer accepts input when idle or recovering from a transient error — but never
  // while streaming or in a terminal blocking state (cost cap / not active / expired).
  // `BLOCKING_STATUSES` is the single source of truth: `streaming` is itself a blocking
  // status, so the in-flight flag never needs a separate guard here.
  const canSend = !BLOCKING_STATUSES.includes(status);

  return {
    turns,
    streaming,
    streamingText: typing.displayText,
    status,
    warning,
    error,
    canSend,
    sendMessage,
    kickoff,
    dismissError,
    applyStatus,
  };
}
