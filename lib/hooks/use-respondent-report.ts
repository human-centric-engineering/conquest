'use client';

/**
 * useRespondentReport — fetch + poll the respondent-facing report view for a completed session.
 *
 * Polls `GET …/questionnaire-sessions/:id/report` every 3s while the insights generation is still
 * `queued`/`processing`, stopping on a terminal state (or when the report isn't an insights report).
 * Sends the anonymous `X-Session-Token` header when given (no-login respondents have no cookie).
 * Single source of truth for the completion screen's download gating + insights rendering.
 */

import { useCallback, useEffect, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';
import type { RespondentReportClientView } from '@/lib/app/questionnaire/report/view';

const POLL_INTERVAL_MS = 3000;
/** Hard cap on polls so a persistently-down endpoint (or a never-enqueued report) can't poll forever. */
const MAX_POLLS = 60;

export interface UseRespondentReportResult {
  view: RespondentReportClientView | null;
  /** True once the first fetch has settled (success or failure). */
  loaded: boolean;
  /**
   * True when polling exhausted {@link MAX_POLLS} without the insights settling — generation is
   * taking longer than the poll window. The completion screen swaps the endless spinner for a calm
   * "taking longer than usual" message + a {@link retry} affordance, so the respondent is never
   * stranded watching a spinner that will never resolve.
   */
  timedOut: boolean;
  /** Restart polling from scratch (clears {@link timedOut}); wired to the fallback's "Check again". */
  retry: () => void;
}

export function useRespondentReport(
  sessionId: string,
  accessToken?: string
): UseRespondentReportResult {
  const [view, setView] = useState<RespondentReportClientView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  // Bumped by `retry` to re-run the polling effect from a fresh attempt count.
  const [retryNonce, setRetryNonce] = useState(0);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTimedOut(false);

    const tick = async () => {
      attempts += 1;
      // `terminal` stays false on a fetch failure too, so a transient error reschedules a retry
      // rather than freezing the screen on "preparing…" forever.
      let terminal = false;
      try {
        const headers: Record<string, string> = {};
        if (accessToken) headers['X-Session-Token'] = accessToken;
        const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.report(sessionId), {
          method: 'GET',
          credentials: 'include',
          headers,
        });
        if (res.ok) {
          const body = (await res.json()) as {
            success: boolean;
            data: RespondentReportClientView;
          };
          if (!cancelled && body.success) {
            setView(body.data);
            const v = body.data;
            const status = v.insights?.status;
            // Nothing more to wait for: no report, raw-only, or generation already settled. The AI
            // modes (raw_plus_insights, narrative) generate async, so keep polling for both.
            terminal =
              !v.enabled ||
              !isAiRespondentReportMode(v.mode) ||
              v.insights === null ||
              status === 'ready' ||
              status === 'failed';
          }
        }
      } catch {
        // Transient — leave the last view; we retry below (terminal is still false).
      } finally {
        if (!cancelled) setLoaded(true);
      }

      if (cancelled || terminal) return;
      if (attempts < MAX_POLLS) {
        timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      } else {
        // Exhausted the window without settling — surface the calm fallback rather than spin forever.
        setTimedOut(true);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, accessToken, retryNonce]);

  return { view, loaded, timedOut, retry };
}
