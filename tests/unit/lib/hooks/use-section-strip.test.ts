// @vitest-environment happy-dom

/**
 * useSectionStrip — the respondent's section tabs and moves between them (P21).
 *
 * Modelled on `useAnswerPanel`'s test (`tests/unit/lib/hooks/use-answer-panel.test.ts`): fakes
 * `fetch` to assert the SSR seed (no fetch when seeded), the `enabled: false` inert mode, the
 * in-flight guard, the dual-mode auth header, the move endpoints, and the fail-quiet error paths.
 *
 * @see lib/hooks/use-section-strip.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useSectionStrip } from '@/lib/hooks/use-section-strip';
import { API } from '@/lib/api/endpoints';
import { INERT_SECTION_STRIP, type SectionStripView } from '@/lib/app/questionnaire/sections/view';

const SESSION_ID = 'sess_1';

function view(overrides: Partial<SectionStripView> = {}): SectionStripView {
  return {
    active: true,
    sections: [
      {
        key: 'a',
        label: 'A',
        position: 1,
        status: 'in_progress',
        isActive: true,
        isAvailable: true,
        reopenCount: 0,
      },
      {
        key: 'b',
        label: 'B',
        position: 2,
        status: 'not_started',
        isActive: false,
        isAvailable: false,
        reopenCount: 0,
      },
    ],
    activeKey: 'a',
    canClose: false,
    blockedOnRequired: false,
    allClosed: false,
    showLocked: true,
    ...overrides,
  };
}

function okResponse(data: SectionStripView): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe('useSectionStrip', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('the seed effect', () => {
    it('paints from the SSR seed without fetching', () => {
      const seed = view({ activeKey: 'b' });
      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      expect(result.current.view).toEqual(seed);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches on first load when there is no seed', async () => {
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'a' })));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, accessToken: 'tok-123' })
      );

      await waitFor(() => expect(result.current.view.activeKey).toBe('a'));

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.sections(SESSION_ID));
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>)['X-Session-Token']).toBe('tok-123');
    });

    it('starts from the inert strip while an unseeded fetch is still in flight', () => {
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
      const { result } = renderHook(() => useSectionStrip({ sessionId: SESSION_ID }));
      expect(result.current.view).toEqual(INERT_SECTION_STRIP);
    });
  });

  describe('enabled: false', () => {
    it('never fetches on mount', () => {
      renderHook(() => useSectionStrip({ sessionId: SESSION_ID, enabled: false }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('makes refetch a no-op', () => {
      const seed = view();
      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, enabled: false, initialView: seed })
      );

      act(() => {
        result.current.refetch();
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.view).toEqual(seed);
    });

    it('makes open/close moves no-ops', () => {
      const seed = view();
      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, enabled: false, initialView: seed })
      );

      act(() => {
        result.current.open('b');
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.moving).toBe(false);
      expect(result.current.view).toEqual(seed);
    });
  });

  describe('refetch', () => {
    it('pulls the latest view', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'b' })));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );
      expect(result.current.view.activeKey).toBe('a');

      await act(async () => {
        result.current.refetch();
      });

      await waitFor(() => expect(result.current.view.activeKey).toBe('b'));
    });

    it('ignores an overlapping refetch while one is already in flight', async () => {
      let release!: (value: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        })
      );

      const seed = view({ activeKey: 'a' });
      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.refetch();
        result.current.refetch();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        release(okResponse(view({ activeKey: 'b' })));
      });
      await waitFor(() => expect(result.current.view.activeKey).toBe('b'));
    });

    it('omits the token header in authenticated mode and sends credentials', async () => {
      fetchMock.mockResolvedValue(okResponse(view()));

      const { result } = renderHook(() => useSectionStrip({ sessionId: SESSION_ID }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Session-Token']).toBeUndefined();
      expect(init.credentials).toBe('include');
      void result;
    });

    it('leaves the previous view on screen when the response is not ok', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.refetch();
      });

      // No throw, no state change: the fail-quiet contract.
      expect(result.current.view).toEqual(seed);
    });

    it('leaves the previous view on screen when fetch itself rejects', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.refetch();
      });

      expect(result.current.view).toEqual(seed);
    });
  });

  describe('open and close', () => {
    it('open POSTs the action and key, and adopts the returned view', async () => {
      const seed = view({ activeKey: 'a' });
      const nextView = view({ activeKey: 'b' });
      fetchMock.mockResolvedValue(okResponse(nextView));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.open('b');
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.sections(SESSION_ID));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ action: 'open', key: 'b' });
      expect(result.current.view.activeKey).toBe('b');
    });

    it('close POSTs the close action', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'b' })));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.close('a');
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ action: 'close', key: 'a' });
    });

    it('sends the X-Session-Token header on a move when an accessToken is given', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'b' })));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, accessToken: 'tok-xyz', initialView: seed })
      );

      await act(async () => {
        result.current.open('b');
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Session-Token']).toBe('tok-xyz');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('calls onMoved with the resulting activeKey', async () => {
      const onMoved = vi.fn();
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'b' })));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed, onMoved })
      );

      await act(async () => {
        result.current.open('b');
      });

      expect(onMoved).toHaveBeenCalledWith('b');
    });

    it('fires the latest onMoved even when the caller passed a fresh inline callback after render', async () => {
      const first = vi.fn();
      const second = vi.fn();
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'b' })));

      const { result, rerender } = renderHook(
        ({ onMoved }: { onMoved: (key: string | null) => void }) =>
          useSectionStrip({ sessionId: SESSION_ID, initialView: seed, onMoved }),
        { initialProps: { onMoved: first } }
      );

      // A re-render with a brand-new inline arrow, the shape a JSX prop takes on every render.
      rerender({ onMoved: second });

      await act(async () => {
        result.current.open('b');
      });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith('b');
    });

    it('gates a second concurrent move while one is already in flight', async () => {
      let release!: (value: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        })
      );

      const seed = view({ activeKey: 'a' });
      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      act(() => {
        result.current.open('b');
      });
      expect(result.current.moving).toBe(true);

      act(() => {
        result.current.open('c');
      });

      // Only the first move went out; the second was refused by the `moving` guard.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        release(okResponse(view({ activeKey: 'b' })));
      });

      await waitFor(() => expect(result.current.moving).toBe(false));
      expect(result.current.view.activeKey).toBe('b');
    });

    it('leaves the previous view on a refused move (non-ok response) and clears moving', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockResolvedValue({ ok: false, status: 409 });

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.open('b');
      });

      expect(result.current.view).toEqual(seed);
      expect(result.current.moving).toBe(false);
    });

    it('leaves the previous view when the move fetch rejects', async () => {
      const seed = view({ activeKey: 'a' });
      fetchMock.mockRejectedValue(new Error('offline'));

      const { result } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed })
      );

      await act(async () => {
        result.current.open('b');
      });

      expect(result.current.view).toEqual(seed);
      expect(result.current.moving).toBe(false);
    });
  });

  describe('unmount safety', () => {
    // test-review:accept assertion-quality - a post-unmount setState is a no-op in React 19 with
    // no warning and no re-render, so the seed fetch's `mountedRef` guard has no externally
    // observable effect of its own. What IS observable is that the settled response does not
    // corrupt the hook for the next mount, which is what this pins.
    it('a response landing after unmount leaves the next mount clean', async () => {
      let release!: (value: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        })
      );

      const { unmount } = renderHook(() => useSectionStrip({ sessionId: SESSION_ID }));
      unmount();

      await act(async () => {
        release(okResponse(view({ activeKey: 'z' })));
      });

      // A fresh mount reads its own response, not the one that landed after the last unmount.
      fetchMock.mockResolvedValue(okResponse(view({ activeKey: 'a' })));
      const second = renderHook(() => useSectionStrip({ sessionId: SESSION_ID }));
      await waitFor(() => expect(second.result.current.view.activeKey).toBe('a'));
    });

    it('does not call onMoved after the component unmounts mid-move', async () => {
      // The `mountedRef` guard in `move` returns BEFORE `onMoved` fires, so a callback that
      // navigates or refocuses cannot run against a surface that is gone. Unlike the seed fetch
      // above, this one is directly observable, and removing the guard fails this test.
      let release!: (value: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          release = resolve;
        })
      );
      const onMoved = vi.fn();

      const seed = view({ activeKey: 'a' });
      const { result, unmount } = renderHook(() =>
        useSectionStrip({ sessionId: SESSION_ID, initialView: seed, onMoved })
      );

      act(() => {
        result.current.open('b');
      });
      unmount();

      await act(async () => {
        release(okResponse(view({ activeKey: 'b' })));
      });

      expect(onMoved).not.toHaveBeenCalled();
    });
  });
});
