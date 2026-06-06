/**
 * useAnswerPanel — the answer-panel fetch hook (F7.2).
 *
 * Fakes fetch to assert the SSR seed (no fetch when seeded), the anonymous first-load
 * fetch, the dual-mode auth header, refetch behaviour, and the error path.
 *
 * @see lib/hooks/use-answer-panel.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useAnswerPanel } from '@/lib/hooks/use-answer-panel';
import { API } from '@/lib/api/endpoints';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

const SESSION_ID = 's1';

function view(over: Partial<AnswerPanelView> = {}): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [],
    answeredCount: 0,
    totalCount: 0,
    ...over,
  };
}

function okResponse(data: AnswerPanelView): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as unknown as Response;
}

describe('useAnswerPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('paints from the SSR seed without fetching', () => {
    const seed = view({ answeredCount: 3, totalCount: 5 });
    const { result } = renderHook(() =>
      useAnswerPanel({ sessionId: SESSION_ID, initialView: seed })
    );

    expect(result.current.view).toEqual(seed);
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches on first load when there is no seed (anonymous path)', async () => {
    fetchMock.mockResolvedValue(okResponse(view({ answeredCount: 1, totalCount: 2 })));

    const { result } = renderHook(() =>
      useAnswerPanel({ sessionId: SESSION_ID, accessToken: 'tok-123' })
    );

    await waitFor(() => expect(result.current.view).not.toBeNull());
    expect(result.current.view!.answeredCount).toBe(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.answers(SESSION_ID));
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-Session-Token']).toBe('tok-123');
  });

  it('omits the token header in authenticated mode', async () => {
    fetchMock.mockResolvedValue(okResponse(view()));

    renderHook(() => useAnswerPanel({ sessionId: SESSION_ID }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Session-Token']).toBeUndefined();
    expect(init.credentials).toBe('include');
  });

  it('refetch pulls the latest view', async () => {
    const seed = view({ answeredCount: 0, totalCount: 2 });
    fetchMock.mockResolvedValue(okResponse(view({ answeredCount: 2, totalCount: 2 })));

    const { result } = renderHook(() =>
      useAnswerPanel({ sessionId: SESSION_ID, initialView: seed })
    );
    expect(result.current.view!.answeredCount).toBe(0);

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.view!.answeredCount).toBe(2));
  });

  it('ignores an overlapping refetch while one is already in flight', async () => {
    // A fetch that never settles holds the in-flight guard open.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      })
    );

    const seed = view({ answeredCount: 0, totalCount: 2 });
    const { result } = renderHook(() =>
      useAnswerPanel({ sessionId: SESSION_ID, initialView: seed })
    );

    await act(async () => {
      result.current.refetch();
      result.current.refetch();
    });

    // Second call short-circuits on the in-flight guard — only one request went out.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(okResponse(view({ answeredCount: 2, totalCount: 2 })));
    });
    await waitFor(() => expect(result.current.view!.answeredCount).toBe(2));
  });

  it('sets error on a failed fetch', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useAnswerPanel({ sessionId: SESSION_ID }));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});
