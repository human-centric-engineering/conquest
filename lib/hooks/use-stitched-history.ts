'use client';

/**
 * Load the earlier legs of an experience run for the stitched surface (P15.3).
 *
 * Fetched client-side rather than SSR-seeded, deliberately. The stitched surface is reached by
 * navigation from the previous leg (`router.push`), not by a fresh document load, so an SSR-only
 * seed would be missing exactly when it is needed most — on the hop that creates the seam. A
 * client fetch behaves identically whether the respondent arrived by navigation or by reload.
 *
 * Returns `null` until loaded and on any failure. A failed history read must degrade to "this leg
 * alone", never to a broken page: the live conversation is the part the respondent is actually
 * answering, and it does not depend on the replay above it.
 */

import { useEffect, useState } from 'react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { StitchedHistory } from '@/lib/app/questionnaire/experiences/run/types';

export interface UseStitchedHistoryOptions {
  /** The run this session belongs to, or null when standalone. */
  runId: string | null;
  sessionId: string;
  /** Signed token for the no-login surface; omitted on the authenticated one. */
  sessionToken?: string;
  /**
   * Whether to fetch. False for `linked`, for a standalone session, and for the entry leg — where
   * nothing precedes this conversation and the request would always return an empty result.
   */
  enabled: boolean;
}

export function useStitchedHistory({
  runId,
  sessionId,
  sessionToken,
  enabled,
}: UseStitchedHistoryOptions): StitchedHistory | null {
  const [history, setHistory] = useState<StitchedHistory | null>(null);

  useEffect(() => {
    if (!enabled || !runId) return;
    let cancelled = false;

    void apiClient
      .get<StitchedHistory>(
        API.APP.EXPERIENCES.runTranscript(runId, sessionId),
        sessionToken ? { options: { headers: { 'X-Session-Token': sessionToken } } } : undefined
      )
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        // Degrade to this leg alone — see the module note.
      });

    return () => {
      cancelled = true;
    };
  }, [runId, sessionId, sessionToken, enabled]);

  return history;
}
