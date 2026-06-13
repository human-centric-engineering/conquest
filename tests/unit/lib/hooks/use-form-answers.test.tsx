/**
 * useFormAnswers — local answer state + debounced autosave for the form surface
 * (P-presentation). Pins the save contract the chat↔form coherence depends on: a value
 * edit PUTs after the debounce; an emptied value PUTs a clear; blur flushes immediately;
 * and the returned view refreshes without clobbering local input values.
 *
 * @see lib/hooks/use-form-answers.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useFormAnswers } from '@/lib/hooks/use-form-answers';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

function view(): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [
      {
        sectionId: 's1',
        title: 'About',
        slots: [
          {
            slotKey: 'role',
            prompt: 'Role?',
            type: 'free_text',
            typeConfig: null,
            required: false,
            answered: false,
            value: null,
            provenance: null,
            confidence: null,
            rationale: null,
            answeredAtTurnIndex: null,
            refinementHistory: [],
          },
        ],
      },
    ],
    answeredCount: 0,
    totalCount: 1,
  };
}

/** Same shape as view() but with the `role` slot answered, so seedValues populates it. */
function answeredView(): AnswerPanelView {
  const v = view();
  v.sections[0].slots[0] = {
    ...v.sections[0].slots[0],
    answered: true,
    value: 'Engineer',
    provenance: 'direct',
    confidence: 1,
  };
  v.answeredCount = 1;
  return v;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: view() }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Find the most recent PUT call's parsed body. */
function lastPutBody() {
  const put = [...fetchMock.mock.calls].reverse().find((c) => c[1]?.method === 'PUT');
  return put ? JSON.parse(put[1].body as string) : null;
}

describe('useFormAnswers', () => {
  it('does not fetch on mount when seeded with an initial view', () => {
    renderHook(() => useFormAnswers({ sessionId: 'sess-1', initialView: view() }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PUTs a value after the debounce window', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Engineer'));
    // Nothing yet — still within the debounce.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', value: 'Engineer' }] });
  });

  it('collapses rapid edits into one save with the freshest value', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Eng'));
    act(() => result.current.setValue('role', 'Engineer'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', value: 'Engineer' }] });
  });

  it('PUTs a clear when the value is emptied', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', ''));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', clear: true }] });
  });

  it('flush saves immediately without waiting for the debounce', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Engineer'));
    await act(async () => {
      result.current.flush('role');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', value: 'Engineer' }] });
  });

  it('keeps the local value authoritative after a save round-trip', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Engineer'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // The PUT response carries the seed view (no value), but the local input value stays.
    expect(result.current.values.role).toBe('Engineer');
  });

  it('fetches and seeds values on mount when enabled with no SSR seed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: answeredView() }),
    });
    const { result } = renderHook(() => useFormAnswers({ sessionId: 'sess-1', enabled: true }));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('view=form'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(result.current.values.role).toBe('Engineer');
  });

  it('does not fetch on mount when disabled (chat-only mode)', async () => {
    renderHook(() => useFormAnswers({ sessionId: 'sess-1', enabled: false }));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks the slot status "error" when a save fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Eng'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.statuses.role).toBe('error');
  });

  it('flush is a no-op when nothing is pending for the slot', () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.flush('role'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refresh re-seeds values from a fresh server view', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: answeredView() }),
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.values.role).toBe('Engineer');
  });

  it('sends the X-Session-Token header for an anonymous/preview session', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', accessToken: 'tok-9', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Eng'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers['X-Session-Token']).toBe('tok-9');
  });

  it('sets the error flag when the initial fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', accessToken: 'tok-9', enabled: true })
    );
    await act(async () => {});
    expect(result.current.error).toBe(true);
  });

  it('treats a non-empty object value as an answer (not a clear)', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', { x: 1 }));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', value: { x: 1 } }] });
  });

  it('cancels a pending debounced save when unmounted', async () => {
    const { result, unmount } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Eng'));
    unmount(); // cleanup clears the pending timer
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
