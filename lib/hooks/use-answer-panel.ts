'use client';

/**
 * useAnswerPanel — fetches the respondent answer-slot panel state (F7.2).
 *
 * Reads `GET /questionnaire-sessions/:id/answers`. Like the turn-stream hook, one hook
 * serves both access modes: authenticated sessions ride the cookie
 * (`credentials: 'include'`); the no-login anonymous mode passes the signed
 * `accessToken` as `X-Session-Token`. Seeds from `initialView` (an SSR-resolved view)
 * so the authenticated panel paints with no fetch flash; the anonymous panel (no SSR
 * seed — the token is client-only) shows a skeleton until its first fetch lands.
 *
 * `refetch` is the live-update entry point: {@link SessionWorkspace} calls it when a
 * turn settles. Overlapping fetches are guarded so a fast double-settle can't race.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/answers/route.ts
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

export interface UseAnswerPanelOptions {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** SSR-resolved initial view (authenticated path); omit for anonymous. */
  initialView?: AnswerPanelView;
}

export interface UseAnswerPanelReturn {
  view: AnswerPanelView | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

interface SuccessEnvelope {
  data: AnswerPanelView;
}

export function useAnswerPanel(options: UseAnswerPanelOptions): UseAnswerPanelReturn {
  const { sessionId, accessToken, initialView } = options;

  const [view, setView] = useState<AnswerPanelView | null>(initialView ?? null);
  // Only show the first-load spinner when we have nothing to paint yet (anonymous path).
  const [loading, setLoading] = useState(initialView === undefined);
  const [error, setError] = useState(false);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(false);

    const headers: Record<string, string> = {};
    if (accessToken) headers['X-Session-Token'] = accessToken;

    void fetch(API.APP.QUESTIONNAIRE_SESSIONS.answers(sessionId), {
      method: 'GET',
      credentials: 'include',
      headers,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SuccessEnvelope;
        if (mountedRef.current) setView(body.data);
      })
      .catch(() => {
        if (mountedRef.current) setError(true);
      })
      .finally(() => {
        inFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      });
  }, [sessionId, accessToken]);

  // Initial load: only fetch when we have no SSR seed (anonymous path).
  useEffect(() => {
    if (initialView === undefined) refetch();
    // initialView is a one-shot seed — re-running on its identity would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch]);

  return { view, loading, error, refetch };
}
