'use client';

/**
 * useFormAnswers — local answer state + autosave for the raw form surface (P-presentation).
 *
 * Backs the `QuestionnaireForm`. Reads the full form view (`GET …/answers?view=form` —
 * every question + its typeConfig + current answers, regardless of `answerSlotPanelScope`)
 * and writes edits back (`PUT …/answers`). Like the panel/stream hooks, one hook serves
 * both access modes: authenticated rides the cookie, anonymous/preview passes the signed
 * `accessToken` as `X-Session-Token`.
 *
 * Autosave (NOT react-hook-form, matching the authoring editors' controlled-state house
 * style) is what makes "both" mode coherent: each edit persists to `AppAnswerSlot`
 * immediately (debounced, with a blur flush), so the chat sees the respondent's own
 * answer on its next turn. An empty value (blank text, no selection, empty multi-choice)
 * persists as a CLEAR (row delete) rather than an invalid empty answer.
 *
 * Local `values` stay authoritative for the inputs (so typing is never disrupted by a
 * save round-trip); the server `view` it returns refreshes the completeness map and
 * provenance/history. `refresh()` re-seeds values from a fresh GET — called when entering
 * the form (e.g. toggling chat → form in "both" mode) so chat-inferred answers appear.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/answers/route.ts
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { API } from '@/lib/api/endpoints';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

/** Per-slot save status, surfaced so a field can show a quiet saving/saved/error hint. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface UseFormAnswersOptions {
  sessionId: string;
  /** Anonymous/preview no-login token; omit for authenticated sessions. */
  accessToken?: string;
  /** SSR-resolved initial form view (authenticated path); omit for anonymous. */
  initialView?: AnswerPanelView;
  /**
   * Gate the initial fetch. `false` (e.g. chat-only mode) keeps the hook inert — no GET,
   * no cost — so it can be called unconditionally. Defaults to `true`.
   */
  enabled?: boolean;
  /** Called after a successful save, so the parent can refresh dependent state (e.g. lifecycle). */
  onSaved?: () => void;
}

export interface UseFormAnswersReturn {
  view: AnswerPanelView | null;
  loading: boolean;
  error: boolean;
  /** Current input values keyed by slotKey (undefined = unanswered). */
  values: Record<string, unknown>;
  /** Per-slot save status keyed by slotKey. */
  statuses: Record<string, SaveStatus>;
  /** Update a value (debounced autosave). An empty value clears the answer. */
  setValue: (slotKey: string, value: unknown) => void;
  /** Flush a pending save immediately (call on blur / before navigating away). */
  flush: (slotKey: string) => void;
  /** Re-seed values from a fresh GET (e.g. entering the form in "both" mode). */
  refresh: () => void;
}

const DEBOUNCE_MS = 400;

interface SuccessEnvelope {
  data: AnswerPanelView;
}

/** A value the form treats as "no answer" → a clear rather than a write. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Seed the editable value map from a view's answered slots. */
function seedValues(view: AnswerPanelView | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!view) return out;
  for (const section of view.sections) {
    for (const slot of section.slots) {
      if (slot.answered) out[slot.slotKey] = slot.value;
    }
  }
  return out;
}

export function useFormAnswers(options: UseFormAnswersOptions): UseFormAnswersReturn {
  const { sessionId, accessToken, initialView, enabled = true, onSaved } = options;

  const [view, setView] = useState<AnswerPanelView | null>(initialView ?? null);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    seedValues(initialView ?? null)
  );
  const [statuses, setStatuses] = useState<Record<string, SaveStatus>>({});
  const [loading, setLoading] = useState(initialView === undefined);
  const [error, setError] = useState(false);

  const mountedRef = useRef(true);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Read `onSaved` + the freshest values through refs so a debounced save (fired later) sees
  // them without re-creating `save` on every change. Updated in an effect, never during render.
  const onSavedRef = useRef(onSaved);
  const latestRef = useRef<Record<string, unknown>>(values);
  useEffect(() => {
    onSavedRef.current = onSaved;
    latestRef.current = values;
  });

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const headers = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) h['X-Session-Token'] = accessToken;
    return h;
  }, [accessToken]);

  const setStatus = useCallback((slotKey: string, status: SaveStatus) => {
    if (mountedRef.current) setStatuses((prev) => ({ ...prev, [slotKey]: status }));
  }, []);

  /** Persist one slot's current value (or clear it when empty). */
  const save = useCallback(
    (slotKey: string) => {
      const value = latestRef.current[slotKey];
      const entry = isEmpty(value)
        ? { questionKey: slotKey, clear: true }
        : { questionKey: slotKey, value };
      setStatus(slotKey, 'saving');
      void fetch(API.APP.QUESTIONNAIRE_SESSIONS.answers(sessionId), {
        method: 'PUT',
        credentials: 'include',
        headers,
        body: JSON.stringify({ answers: [entry] }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as SuccessEnvelope;
          // Refresh the view (completeness map + provenance/history) but keep local values
          // authoritative so the user's in-progress typing is never clobbered.
          if (mountedRef.current) setView(body.data);
          setStatus(slotKey, 'saved');
          onSavedRef.current?.();
        })
        .catch(() => setStatus(slotKey, 'error'));
    },
    [sessionId, headers, setStatus]
  );

  const scheduleSave = useCallback(
    (slotKey: string) => {
      const timers = timersRef.current;
      const existing = timers.get(slotKey);
      if (existing) clearTimeout(existing);
      timers.set(
        slotKey,
        setTimeout(() => {
          timers.delete(slotKey);
          save(slotKey);
        }, DEBOUNCE_MS)
      );
    },
    [save]
  );

  const setValue = useCallback(
    (slotKey: string, value: unknown) => {
      setValues((prev) => ({ ...prev, [slotKey]: value }));
      scheduleSave(slotKey);
    },
    [scheduleSave]
  );

  const flush = useCallback(
    (slotKey: string) => {
      const timers = timersRef.current;
      const existing = timers.get(slotKey);
      if (!existing) return; // nothing pending
      clearTimeout(existing);
      timers.delete(slotKey);
      save(slotKey);
    },
    [save]
  );

  const refresh = useCallback(() => {
    setError(false);
    const getHeaders: Record<string, string> = {};
    if (accessToken) getHeaders['X-Session-Token'] = accessToken;
    void fetch(`${API.APP.QUESTIONNAIRE_SESSIONS.answers(sessionId)}?view=form`, {
      method: 'GET',
      credentials: 'include',
      headers: getHeaders,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SuccessEnvelope;
        if (!mountedRef.current) return;
        setView(body.data);
        setValues(seedValues(body.data));
      })
      .catch(() => {
        if (mountedRef.current) setError(true);
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, [sessionId, accessToken]);

  // Initial load: fetch when enabled and there's no SSR seed (anonymous/preview path).
  useEffect(() => {
    if (enabled && initialView === undefined) refresh();
    // initialView is a one-shot seed — re-running on its identity would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, enabled]);

  return { view, loading, error, values, statuses, setValue, flush, refresh };
}

/** Flatten a view's sections to a single ordered slot list (form rendering order). */
export function flattenFormSlots(view: AnswerPanelView | null): PanelSlotView[] {
  if (!view) return [];
  return view.sections.flatMap((s) => s.slots);
}
