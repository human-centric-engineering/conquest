'use client';

/**
 * useRespondentReport — fetch + poll the respondent-facing report view for a completed session.
 *
 * Polls `GET …/questionnaire-sessions/:id/report` every 3s while the insights generation is still
 * `queued`/`processing`, stopping on a terminal state (or when the report isn't an insights report).
 * Sends the anonymous `X-Session-Token` header when given (no-login respondents have no cookie).
 * Single source of truth for the completion screen's download gating + insights rendering.
 */

import { useEffect, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import type { RespondentReportClientView } from '@/lib/app/questionnaire/report/view';

const POLL_INTERVAL_MS = 3000;

export interface UseRespondentReportResult {
  view: RespondentReportClientView | null;
  /** True once the first fetch has settled (success or failure). */
  loaded: boolean;
}

export function useRespondentReport(
  sessionId: string,
  accessToken?: string
): UseRespondentReportResult {
  const [view, setView] = useState<RespondentReportClientView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
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
            const status = body.data.insights?.status;
            if (body.data.enabled && (status === 'queued' || status === 'processing')) {
              timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
            }
          }
        }
      } catch {
        // Transient — leave the last view; the screen degrades gracefully.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, accessToken]);

  return { view, loaded };
}
