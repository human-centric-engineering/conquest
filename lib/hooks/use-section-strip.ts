'use client';

/**
 * useSectionStrip — the respondent's section tabs, and the moves between them (P21).
 *
 * Reads `GET /questionnaire-sessions/:id/sections` and posts the two moves to the same address.
 * Modelled on {@link useAnswerPanel}: one hook for both access modes (the cookie for an
 * authenticated session, `X-Session-Token` for the no-login one), refetched when a turn settles,
 * and inert when the surface has no business reading it.
 *
 * Deliberately NOT part of the messages stream. The stream's frames are
 * `start | content | warning | done | error`, and F7.2 already established that a panel reads its
 * own endpoint rather than widening that contract; the section strip changes on exactly the same
 * cadence and takes the same route.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/sections/route.ts
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import { INERT_SECTION_STRIP, type SectionStripView } from '@/lib/app/questionnaire/sections/view';

export interface UseSectionStripOptions {
  sessionId: string;
  /** Anonymous no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** SSR-resolved initial view, when the host page could resolve one. */
  initialView?: SectionStripView;
  /**
   * Whether the strip is live. `false` makes the hook inert — no fetch, no moves — for surfaces
   * with no respondent credential to read it with (the admin read-only viewer).
   */
  enabled?: boolean;
  /**
   * Called after a move lands, with the key that is now active.
   *
   * This is the hook's one piece of choreography: the workspace uses it to bring the newly-active
   * section's captured answers into focus, and to fire the kickoff turn when the section has never
   * been spoken in.
   */
  onMoved?: (activeKey: string | null) => void;
}

export interface UseSectionStripReturn {
  view: SectionStripView;
  /** True while a move is in flight. The controls disable rather than queueing a second one. */
  moving: boolean;
  refetch: () => void;
  open: (key: string) => void;
  /**
   * Finish a section. `reason` records WHO decided: omitted, the respondent pressed the control;
   * `agent_offer`, the interviewer announced the move and the surface kept that promise. It is an
   * audit label on the run, never a gate — the server assesses the close itself either way.
   */
  close: (key: string, reason?: SectionCloseTrigger) => void;
}

/** Who asked for a section to be finished. See {@link UseSectionStripReturn.close}. */
export type SectionCloseTrigger = 'agent_offer';

interface SuccessEnvelope {
  data: SectionStripView;
}

export function useSectionStrip(options: UseSectionStripOptions): UseSectionStripReturn {
  const { sessionId, accessToken, initialView, enabled = true, onMoved } = options;

  const [view, setView] = useState<SectionStripView>(initialView ?? INERT_SECTION_STRIP);
  const [moving, setMoving] = useState(false);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  // Held in a ref so a caller passing an inline arrow does not re-create `open`/`close` every
  // render, which would re-run every effect depending on them. Synced in an effect rather than
  // assigned during render: a ref write during render is not safe under concurrent rendering, and
  // the only reader is an async `.then`, which cannot run before the effect has committed.
  const onMovedRef = useRef(onMoved);
  useEffect(() => {
    onMovedRef.current = onMoved;
  }, [onMoved]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {};
    if (accessToken) h['X-Session-Token'] = accessToken;
    return h;
  }, [accessToken]);

  const refetch = useCallback(() => {
    if (!enabled) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    void fetch(API.APP.QUESTIONNAIRE_SESSIONS.sections(sessionId), {
      method: 'GET',
      credentials: 'include',
      headers: headers(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SuccessEnvelope;
        if (mountedRef.current) setView(body.data);
      })
      // Fail quiet: an unreachable strip leaves the last good one on screen. The alternative is
      // collapsing the tabs mid-conversation, which reads as the interview losing its shape.
      .catch(() => {})
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [sessionId, enabled, headers]);

  const move = useCallback(
    (action: 'open' | 'close', key: string, reason?: SectionCloseTrigger) => {
      if (!enabled || moving) return;
      setMoving(true);

      void fetch(API.APP.QUESTIONNAIRE_SESSIONS.sections(sessionId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ action, key, ...(reason ? { reason } : {}) }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as SuccessEnvelope;
          if (!mountedRef.current) return;
          setView(body.data);
          onMovedRef.current?.(body.data.activeKey);
        })
        // A refused move (the section locked, the gate not met) leaves the strip as it was. The
        // server is the authority on both, and the controls it refused are already drawn from the
        // same view, so there is nothing to correct.
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setMoving(false);
        });
    },
    [sessionId, enabled, moving, headers]
  );

  const open = useCallback((key: string) => move('open', key), [move]);
  const close = useCallback(
    (key: string, reason?: SectionCloseTrigger) => move('close', key, reason),
    [move]
  );

  useEffect(() => {
    if (initialView === undefined) refetch();
    // A one-shot seed: re-running on its identity would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch]);

  return { view, moving, refetch, open, close };
}
