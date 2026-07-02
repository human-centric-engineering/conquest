/**
 * useFormAnswers — local answer state + debounced autosave for the form surface
 * (P-presentation). Pins the save contract the chat↔form coherence depends on: a value
 * edit PUTs after the debounce; an emptied value PUTs a clear; blur flushes immediately;
 * and the returned view refreshes without clobbering local input values.
 *
 * @see lib/hooks/use-form-answers.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useFormAnswers, flattenFormSlots } from '@/lib/hooks/use-form-answers';
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
            respondentEdited: false,
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

// Typed with fetch's argument shape (input, init) so `call[1]` is a `RequestInit` — the tests read
// `.method` / `.body` / `.headers` off it. The return is `unknown` (the mock yields a lightweight
// `{ ok, json }` stub, not a real `Response`).
type FetchArgs = (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
let fetchMock: Mock<FetchArgs>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<FetchArgs>().mockResolvedValue({
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
  return put ? JSON.parse(put[1]!.body as string) : null;
}

describe('useFormAnswers', () => {
  it('does not fetch on mount when seeded with an initial view', () => {
    renderHook(() => useFormAnswers({ sessionId: 'sess-1', initialView: view() }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tracks edited slots so seeded answers are not mistaken for respondent edits', () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    // Seeded from the view, but untouched → no edits recorded (so inferred markers stay visible).
    expect(result.current.editedKeys.has('role')).toBe(false);
    act(() => result.current.setValue('role', 'Engineer'));
    // Now it's the respondent's own → recorded as edited.
    expect(result.current.editedKeys.has('role')).toBe(true);
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

  it('serializes concurrent saves — one PUT in flight, later edits flushed after it settles', async () => {
    // Deferred PUT responses so we control resolution order (mimics network latency on Vercel,
    // where the bug lived: concurrent single-slot PUTs whose staler response lands last).
    const resolvers: Array<(v: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    // Rapidly answer two different slots; both debounces fire in the same tick.
    act(() => result.current.setValue('role', 'Engineer'));
    act(() => result.current.setValue('team', 'Platform'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // Only ONE PUT is in flight — the second edit is queued behind it, not raced.
    let puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0][1]!.body as string)).toEqual({
      answers: [{ questionKey: 'role', value: 'Engineer' }],
    });
    // Settle the first PUT → the queued edit flushes as the next PUT.
    await act(async () => {
      resolvers[0]({ ok: true, json: () => Promise.resolve({ data: view() }) });
    });
    puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1][1]!.body as string)).toEqual({
      answers: [{ questionKey: 'team', value: 'Platform' }],
    });
  });

  it('batches slots edited while a save is in flight into a single PUT', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Engineer'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1);
    // Two more edits land while the first PUT is still in flight.
    act(() => result.current.setValue('team', 'Platform'));
    act(() => result.current.setValue('level', 'Senior'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // Still one PUT — the new edits are queued, not fired concurrently.
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1);
    // Settle the first PUT → both queued edits flush together in ONE batched PUT.
    await act(async () => {
      resolvers[0]({ ok: true, json: () => Promise.resolve({ data: view() }) });
    });
    const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1][1]!.body as string)).toEqual({
      answers: [
        { questionKey: 'team', value: 'Platform' },
        { questionKey: 'level', value: 'Senior' },
      ],
    });
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

  it('reports an aggregate saveState that is "saving" during the debounce window', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    expect(result.current.saveState).toBe('idle');
    // A queued-but-unsent edit must already read as "saving" — the indicator never claims
    // "saved" while a change is still pending.
    act(() => result.current.setValue('role', 'Engineer'));
    expect(result.current.saveState).toBe('saving');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.saveState).toBe('saved');
    expect(result.current.lastSavedAt).not.toBeNull();
  });

  it('aggregate saveState surfaces "error" and outranks a saved slot', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Eng'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.saveState).toBe('error');
  });

  it('refresh clears stale per-slot statuses after a re-seed', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', 'Eng'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.saveState).toBe('error');
    // A fresh server sync should drop the stale error pill rather than leave it lingering.
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: view() }) });
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.statuses).toEqual({});
    expect(result.current.saveState).toBe('idle');
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
    const headers = fetchMock.mock.calls.at(-1)![1]!.headers as Record<string, string>;
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

  it('calls onSaved once after a successful save completes', async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view(), onSaved })
    );
    act(() => result.current.setValue('role', 'Engineer'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // onSaved is invoked inside the PUT .then handler — after the fetch resolves.
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('PUTs a clear when the value is set to null', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', null));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', clear: true }] });
  });

  it('PUTs a clear when the value is set to an empty array', async () => {
    const { result } = renderHook(() =>
      useFormAnswers({ sessionId: 'sess-1', initialView: view() })
    );
    act(() => result.current.setValue('role', []));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', clear: true }] });
  });
});

describe('flattenFormSlots', () => {
  it('returns [] when view is null', () => {
    expect(flattenFormSlots(null)).toEqual([]);
  });

  it('returns all slots from a single-section view in order', () => {
    const v = view();
    const flat = flattenFormSlots(v);
    expect(flat).toHaveLength(1);
    expect(flat[0].slotKey).toBe('role');
  });

  it('flattens slots from multiple sections into a single ordered list', () => {
    const slotA = view().sections[0].slots[0]; // 'role'
    const slotB = { ...slotA, slotKey: 'team' };
    const multiSection: AnswerPanelView = {
      ...view(),
      sections: [
        { sectionId: 's1', title: 'About', slots: [slotA] },
        { sectionId: 's2', title: 'Team', slots: [slotB] },
      ],
      totalCount: 2,
    };
    const flat = flattenFormSlots(multiSection);
    expect(flat).toHaveLength(2);
    expect(flat[0].slotKey).toBe('role');
    expect(flat[1].slotKey).toBe('team');
  });
});
