'use client';

/**
 * useInlineCorrection — single-shot answer correction for the inline "fix this answer" gesture
 * (Variant B).
 *
 * Writes a small batch of answers back through `PUT …/answers` — the same form-edit endpoint the
 * raw form uses — so a correction records a `manual` refinement-history entry, flips the slot(s) to
 * `refined` + `respondentEdited`, and (in data-slot mode) reconciles the data-slot reading. Crucially
 * it routes AROUND the turn pipeline: a fix never runs extraction or contradiction detection, so it
 * can't trigger a same-slot contradiction warning the way a corrective chat turn would.
 *
 * Unlike {@link useFormAnswers} (debounced per-slot autosave for the whole form) this is an explicit,
 * one-shot submit of one or more entries: a question-mode fix sends one entry; a data-slot fix sends
 * the slot's mapped questions together. Like the panel/form hooks, one hook serves both access modes:
 * authenticated rides the cookie, anonymous/preview passes the signed `accessToken` as
 * `X-Session-Token`.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/answers/route.ts
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

/** One answer to correct: set `value`, or an empty value clears it (row delete). */
export interface CorrectionEntry {
  questionKey: string;
  value: unknown;
}

export interface UseInlineCorrectionOptions {
  sessionId: string;
  /** Anonymous/preview no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** Called with the refreshed panel view after a successful save (e.g. to refetch dependent state). */
  onSaved?: (view: AnswerPanelView) => void;
}

export interface UseInlineCorrectionReturn {
  saving: boolean;
  error: boolean;
  /** Persist a batch of corrections. Resolves `true` on success, `false` on failure. */
  submit: (entries: CorrectionEntry[]) => Promise<boolean>;
}

interface SuccessEnvelope {
  data: AnswerPanelView;
}

/** A value treated as "no answer" → a clear (row delete) rather than a write. Mirrors useFormAnswers. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function useInlineCorrection(
  options: UseInlineCorrectionOptions
): UseInlineCorrectionReturn {
  const { sessionId, accessToken, onSaved } = options;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  // Read `onSaved` through a ref so `submit` stays stable across renders.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const headers = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) h['X-Session-Token'] = accessToken;
    return h;
  }, [accessToken]);

  const submit = useCallback(
    async (entries: CorrectionEntry[]): Promise<boolean> => {
      if (entries.length === 0) return true;
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      if (mountedRef.current) {
        setSaving(true);
        setError(false);
      }

      const answers = entries.map((e) =>
        isEmpty(e.value)
          ? { questionKey: e.questionKey, clear: true }
          : { questionKey: e.questionKey, value: e.value }
      );

      try {
        const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.answers(sessionId), {
          method: 'PUT',
          credentials: 'include',
          headers,
          body: JSON.stringify({ answers }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SuccessEnvelope;
        onSavedRef.current?.(body.data);
        return true;
      } catch {
        if (mountedRef.current) setError(true);
        return false;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [sessionId, headers]
  );

  return { saving, error, submit };
}
