'use client';

/**
 * Poll an experience run until the fork after a completed leg resolves (P15.3).
 *
 * Extracted from `HandoffCard` when `stitched` needed the same wait with a different presentation:
 * `linked` shows a card and waits for a tap, `stitched` shows a typing indicator and continues on
 * its own. Both are watching the identical server-side event, so they share the loop rather than
 * keeping two copies that drift on the parts that are easy to get wrong — the timeout, the hidden
 * tab, and stopping.
 *
 * Three behaviours worth keeping:
 *
 *  - **Polling stops.** After {@link RUN_POLL_TIMEOUT_MS} it gives up and reports `failed`, rather
 *    than spinning forever against a handoff that will never resolve.
 *  - **It backs off when hidden.** A backgrounded tab defers instead of polling, so a phone left
 *    on a desk is not quietly generating requests for an hour. Returning wakes it immediately.
 *  - **A transient error is not a failure.** A dropped poll mid-flight keeps waiting; only the
 *    timeout gives up. The handoff involves an LLM call and a session create — a single 500 on the
 *    way there says nothing about the outcome.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  RUN_POLL_INTERVAL_MS,
  RUN_POLL_TIMEOUT_MS,
} from '@/lib/app/questionnaire/experiences/constants';
import type { RunPollState } from '@/lib/app/questionnaire/experiences/run/types';

export interface UseRunHandoffOptions {
  runId: string;
  /** The leg just completed — so a newly-minted later leg is recognised as the fork resolving. */
  sessionId: string;
  /** Signed token for the no-login surface; omitted on the authenticated one. */
  sessionToken?: string;
  /**
   * Whether to poll at all. `false` holds the hook inert at `pending` — used so a surface can mount
   * it unconditionally and obey the rules of hooks while the run is not actually awaiting a fork.
   */
  enabled?: boolean;
}

export function useRunHandoff({
  runId,
  sessionId,
  sessionToken,
  enabled = true,
}: UseRunHandoffOptions): RunPollState {
  const [state, setState] = useState<RunPollState>({ state: 'pending' });
  // Stamped in the effect, not at render: reading the clock during render is impure (it would
  // differ between a server render and its hydration, and between Strict Mode's double render).
  const startedAt = useRef(0);
  const stopped = useRef(false);

  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const next = await apiClient.get<RunPollState>(
        API.APP.EXPERIENCES.runStatus(runId, sessionId),
        sessionToken ? { options: { headers: { 'X-Session-Token': sessionToken } } } : undefined
      );
      setState(next);
      return next.state !== 'pending';
    } catch {
      // A transient failure mid-poll is not a failed handoff — keep waiting and let the timeout
      // be the thing that gives up.
      return false;
    }
  }, [runId, sessionId, sessionToken]);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    startedAt.current = Date.now();
    stopped.current = false;

    const tick = async () => {
      if (stopped.current) return;

      // A backgrounded tab defers rather than polls — re-checked on the next tick, and the
      // visibilitychange listener below wakes it immediately when the respondent returns.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(() => void tick(), RUN_POLL_INTERVAL_MS);
        return;
      }

      if (Date.now() - startedAt.current > RUN_POLL_TIMEOUT_MS) {
        stopped.current = true;
        setState({
          state: 'failed',
          message:
            "This is taking longer than expected. Your answers are saved — you can close this and we'll be in touch.",
        });
        return;
      }

      const done = await poll();
      if (done) {
        stopped.current = true;
        return;
      }
      timer = setTimeout(() => void tick(), RUN_POLL_INTERVAL_MS);
    };

    void tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped.current) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll, enabled]);

  return state;
}
