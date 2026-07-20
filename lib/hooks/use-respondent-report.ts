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
  /**
   * Re-trigger generation and restart polling from scratch (clears {@link timedOut}); wired to the
   * fallback's "Check again". POSTs the retry endpoint first (re-queues a failed/orphaned report and
   * kicks the worker), then polls again — so "Check again" actually makes progress rather than just
   * re-reading a dead row.
   */
  retry: () => void;
  /**
   * Opt in to a report-ready email. POSTs the notify endpoint; resolves `true` when the email was
   * accepted (a report is still in flight to notify about).
   */
  notify: (email: string) => Promise<boolean>;
}

export function useRespondentReport(
  sessionId: string,
  accessToken?: string,
  /**
   * Experiences (F15.4b): when this session is a leg of a run, poll the RUN-level report instead
   * of the session's own — a leg no longer generates one, because the run report covers every leg.
   *
   * Passed rather than derived so the hook stays a pure poller with no lookup of its own; the
   * workspace already knows the run from the session status view.
   */
  runId?: string | null
): UseRespondentReportResult {
  const [view, setView] = useState<RespondentReportClientView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  // Bumped by `retry` to re-run the polling effect from a fresh attempt count.
  const [retryNonce, setRetryNonce] = useState(0);

  const authHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers['X-Session-Token'] = accessToken;
    return headers;
  }, [accessToken]);

  const retry = useCallback(() => {
    // A run report has no re-queue endpoint yet, so "Check again" opens a fresh poll window rather
    // than re-triggering generation. That is still honest progress — the worker may simply have
    // been slower than the poll window — and it is strictly better than a dead button.
    if (runId) {
      setRetryNonce((n) => n + 1);
      return;
    }
    // Best-effort re-trigger: re-queue a failed/orphaned report and kick the worker, then restart
    // polling regardless of the POST's outcome (a transient failure still gets a fresh poll window).
    void fetch(API.APP.QUESTIONNAIRE_SESSIONS.reportRetry(sessionId), {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
    })
      .catch(() => {})
      .finally(() => setRetryNonce((n) => n + 1));
  }, [sessionId, runId, authHeaders]);

  const notify = useCallback(
    async (email: string): Promise<boolean> => {
      // No run-scoped notify endpoint yet. Returning false makes the UI report that the opt-in did
      // not take, rather than POSTing the entry leg's session route and quietly promising an email
      // about a report that leg is not generating.
      if (runId) return false;
      try {
        const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.reportNotify(sessionId), {
          method: 'POST',
          credentials: 'include',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { success: boolean; data?: { notifying?: boolean } };
        return Boolean(body.success && body.data?.notifying);
      } catch {
        return false;
      }
    },
    [sessionId, runId, authHeaders]
  );

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
        const url = runId
          ? API.APP.EXPERIENCES.runReport(runId)
          : API.APP.QUESTIONNAIRE_SESSIONS.report(sessionId);
        const res = await fetch(url, {
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
  }, [sessionId, accessToken, runId, retryNonce]);

  return { view, loaded, timedOut, retry, notify };
}
