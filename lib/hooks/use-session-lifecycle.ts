'use client';

/**
 * useSessionLifecycle — drives the respondent session lifecycle UI (F7.3).
 *
 * The companion to {@link useAnswerPanel}: it reads `GET …/status` (the completion-offer
 * signal, cost tier, anonymous flag the SSE stream doesn't carry) and exposes the
 * pause / resume / submit actions. Like the panel hook, one hook serves both access
 * modes — authenticated sessions ride the cookie, the no-login mode passes the signed
 * `accessToken` as `X-Session-Token`. {@link SessionWorkspace} refetches it on the same
 * `onTurnSettled` that drives the panel, so a Submit affordance appears the moment the
 * questionnaire is ready.
 *
 * Lifecycle actions change status server-side, then push the authoritative status into
 * the shared stream via `applyStatus` (so the composer enables/disables in lockstep) and
 * refetch the view. Pause/resume is signed-in only — the endpoint enforces it; this hook
 * mirrors that in `canPause`/`canResume` so the UI never offers an action that would 403.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/status/route.ts
 * @see app/api/v1/app/questionnaire-sessions/[id]/lifecycle/route.ts
 * @see app/api/v1/app/questionnaire-sessions/[id]/submit/route.ts
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import {
  canSubmitSession,
  type SessionStatusView,
} from '@/lib/app/questionnaire/session/status-view';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';

export interface UseSessionLifecycleOptions {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** SSR-resolved initial view (authenticated path); omit for anonymous. */
  initialView?: SessionStatusView;
  /** Push the authoritative status into the shared stream (from {@link SessionWorkspace}). */
  applyStatus: (status: QuestionnaireChatStatus) => void;
}

export interface UseSessionLifecycleReturn {
  view: SessionStatusView | null;
  /** First-load spinner (anonymous path only — the authed path is SSR-seeded). */
  loading: boolean;
  /** A pause/resume/submit is in flight. */
  busy: boolean;
  /** Friendly copy for the most recent failed action, or null. */
  actionError: string | null;
  /** Whether the Submit affordance should show (active + offer). */
  canSubmit: boolean;
  /** Whether a respondent Pause should show (signed-in + active). */
  canPause: boolean;
  /** Whether Resume should show (signed-in + respondent-paused, not budget-paused). */
  canResume: boolean;
  refetch: () => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  submit: () => Promise<void>;
}

interface SuccessEnvelope {
  data: SessionStatusView;
}
interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

const ACTION_FALLBACK = 'Something went wrong. Please try again.';

export function useSessionLifecycle(
  options: UseSessionLifecycleOptions
): UseSessionLifecycleReturn {
  const { sessionId, accessToken, initialView, applyStatus } = options;
  const anonymous = Boolean(accessToken);

  const [view, setView] = useState<SessionStatusView | null>(initialView ?? null);
  const [loading, setLoading] = useState(initialView === undefined);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const authHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers['X-Session-Token'] = accessToken;
    return headers;
  }, [accessToken]);

  const refetch = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    void fetch(API.APP.QUESTIONNAIRE_SESSIONS.status(sessionId), {
      method: 'GET',
      credentials: 'include',
      headers: authHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SuccessEnvelope;
        if (mountedRef.current) setView(body.data);
      })
      .catch(() => {
        // A status read failing is non-fatal — the chat still works; just skip the update.
      })
      .finally(() => {
        inFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      });
  }, [sessionId, authHeaders]);

  // Initial load only when there's no SSR seed (anonymous path).
  useEffect(() => {
    if (initialView === undefined) refetch();
    // initialView is a one-shot seed — re-running on its identity would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch]);

  /** POST a lifecycle/submit action; on success push status + refetch, else surface copy. */
  const runAction = useCallback(
    async (url: string, body: unknown, onOk: () => void): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
          let message: string | undefined;
          try {
            message = ((await res.json()) as ErrorEnvelope).error?.message;
          } catch {
            // Non-JSON body — fall back to generic copy.
          }
          if (mountedRef.current) setActionError(message ?? ACTION_FALLBACK);
          return;
        }
        if (mountedRef.current) {
          onOk();
          refetch();
        }
      } catch {
        if (mountedRef.current) setActionError(ACTION_FALLBACK);
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, authHeaders, refetch]
  );

  const pause = useCallback(
    () =>
      runAction(API.APP.QUESTIONNAIRE_SESSIONS.lifecycle(sessionId), { action: 'pause' }, () =>
        applyStatus('not_active')
      ),
    [runAction, sessionId, applyStatus]
  );

  const resume = useCallback(
    () =>
      runAction(API.APP.QUESTIONNAIRE_SESSIONS.lifecycle(sessionId), { action: 'resume' }, () =>
        applyStatus('idle')
      ),
    [runAction, sessionId, applyStatus]
  );

  const submit = useCallback(
    () =>
      runAction(API.APP.QUESTIONNAIRE_SESSIONS.submit(sessionId), undefined, () =>
        applyStatus('completed')
      ),
    [runAction, sessionId, applyStatus]
  );

  const canSubmit = view !== null && canSubmitSession(view);
  const canPause = !anonymous && view?.status === 'active';
  // A budget-paused session (cost hard) isn't respondent-resumable — resuming would hit the
  // hard cap again immediately. Only a respondent-initiated pause offers Resume.
  const canResume = !anonymous && view?.status === 'paused' && view.cost?.tier !== 'hard';

  return {
    view,
    loading,
    busy,
    actionError,
    canSubmit,
    canPause,
    canResume,
    refetch,
    pause,
    resume,
    submit,
  };
}
