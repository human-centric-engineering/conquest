/**
 * useSessionLifecycle — the lifecycle status + actions hook (F7.3).
 *
 * Fakes fetch to assert the SSR seed (no fetch when seeded), the anonymous first-load
 * fetch + token header, the derived affordance flags (canSubmit / canPause / canResume),
 * and that pause/resume/submit POST the right endpoints, push status into the stream via
 * `applyStatus`, and surface a friendly error on failure.
 *
 * @see lib/hooks/use-session-lifecycle.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useSessionLifecycle } from '@/lib/hooks/use-session-lifecycle';
import { API } from '@/lib/api/endpoints';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';

const SESSION_ID = 's1';

function view(over: Partial<SessionStatusView> = {}): SessionStatusView {
  return {
    status: 'active',
    completion: {
      kind: 'offer',
      coverage: 0.9,
      answeredCount: 4,
      requiredUnansweredKeys: [],
      capReached: false,
      earlyFinishAvailable: false,
    },
    cost: null,
    anonymous: false,
    ref: null,
    ...over,
  };
}

function okResponse(data: SessionStatusView): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as unknown as Response;
}
function okPost(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: {} }),
  } as unknown as Response;
}
function errPost(message: string, status = 409): Response {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, error: { code: 'SUBMIT_NOT_READY', message } }),
  } as unknown as Response;
}
/** A submit that was HELD by the final sweep — active, with a reconciliation probe. */
function heldPost(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        sessionId: SESSION_ID,
        status: 'active',
        held: true,
        probe: { text: 'Earlier X, now Y — which is right?', slotKeys: ['role'] },
        notice: 'That differs from an earlier answer.',
        early: false,
      },
    }),
  } as unknown as Response;
}

describe('useSessionLifecycle', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const applyStatus = vi.fn<(status: QuestionnaireChatStatus) => void>();

  beforeEach(() => {
    fetchMock = vi.fn();
    applyStatus.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('paints from the SSR seed without fetching', () => {
    const { result } = renderHook(() =>
      useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
    );
    expect(result.current.view).not.toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches on first load with the token header (anonymous path)', async () => {
    fetchMock.mockResolvedValue(okResponse(view({ anonymous: true })));
    const { result } = renderHook(() =>
      useSessionLifecycle({ sessionId: SESSION_ID, accessToken: 'tok-1', applyStatus })
    );
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.status(SESSION_ID));
    expect((init.headers as Record<string, string>)['X-Session-Token']).toBe('tok-1');
  });

  describe('derived affordances', () => {
    it('canSubmit only when active + offer', () => {
      const offering = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      expect(offering.result.current.canSubmit).toBe(true);

      const notReady = renderHook(() =>
        useSessionLifecycle({
          sessionId: SESSION_ID,
          initialView: view({ completion: { ...view().completion, kind: 'not_ready' } }),
          applyStatus,
        })
      );
      expect(notReady.result.current.canSubmit).toBe(false);
    });

    it('canPause for an authed active session, not for anonymous', () => {
      const authed = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      expect(authed.result.current.canPause).toBe(true);

      const anon = renderHook(() =>
        useSessionLifecycle({
          sessionId: SESSION_ID,
          accessToken: 'tok',
          initialView: view({ anonymous: true }),
          applyStatus,
        })
      );
      expect(anon.result.current.canPause).toBe(false);
    });

    it('canResume for a respondent-paused session but NOT a budget-paused one', () => {
      const respondentPaused = renderHook(() =>
        useSessionLifecycle({
          sessionId: SESSION_ID,
          initialView: view({ status: 'paused', cost: { tier: 'none' } }),
          applyStatus,
        })
      );
      expect(respondentPaused.result.current.canResume).toBe(true);

      const budgetPaused = renderHook(() =>
        useSessionLifecycle({
          sessionId: SESSION_ID,
          initialView: view({ status: 'paused', cost: { tier: 'hard' } }),
          applyStatus,
        })
      );
      expect(budgetPaused.result.current.canResume).toBe(false);
    });
  });

  describe('actions', () => {
    it('pause POSTs the lifecycle endpoint and pushes not_active', async () => {
      // first the action POST, then the follow-up status refetch
      fetchMock
        .mockResolvedValueOnce(okPost())
        .mockResolvedValueOnce(okResponse(view({ status: 'paused' })));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      await act(async () => {
        await result.current.pause();
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.lifecycle(SESSION_ID));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ action: 'pause' });
      expect(applyStatus).toHaveBeenCalledWith('not_active');
    });

    it('resume pushes idle', async () => {
      fetchMock.mockResolvedValueOnce(okPost()).mockResolvedValueOnce(okResponse(view()));
      const { result } = renderHook(() =>
        useSessionLifecycle({
          sessionId: SESSION_ID,
          initialView: view({ status: 'paused' }),
          applyStatus,
        })
      );
      await act(async () => {
        await result.current.resume();
      });
      expect(applyStatus).toHaveBeenCalledWith('idle');
    });

    it('submit POSTs the submit endpoint and pushes completed', async () => {
      fetchMock
        .mockResolvedValueOnce(okPost())
        .mockResolvedValueOnce(okResponse(view({ status: 'completed' })));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      await act(async () => {
        await result.current.submit();
      });
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.submit(SESSION_ID));
      expect(applyStatus).toHaveBeenCalledWith('completed');
    });

    it('submit HELD by the final sweep calls onHeld and does NOT complete', async () => {
      const onHeld = vi.fn();
      fetchMock.mockResolvedValueOnce(heldPost()).mockResolvedValueOnce(okResponse(view()));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus, onHeld })
      );
      await act(async () => {
        await result.current.submit();
      });
      expect(onHeld).toHaveBeenCalledWith(
        {
          text: 'Earlier X, now Y — which is right?',
          slotKeys: ['role'],
          notice: 'That differs from an earlier answer.',
        },
        { early: false }
      );
      expect(applyStatus).not.toHaveBeenCalledWith('completed');
    });

    it('finishEarly HELD flags early:true to onHeld', async () => {
      const onHeld = vi.fn();
      fetchMock.mockResolvedValueOnce(heldPost()).mockResolvedValueOnce(okResponse(view()));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus, onHeld })
      );
      await act(async () => {
        await result.current.finishEarly();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ early: true });
      expect(onHeld).toHaveBeenCalledWith(expect.anything(), { early: true });
    });

    it('finishAnyway posts skipSweep and completes', async () => {
      fetchMock.mockResolvedValueOnce(okPost()).mockResolvedValueOnce(okResponse(view()));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      await act(async () => {
        await result.current.finishAnyway(true);
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.submit(SESSION_ID));
      expect(JSON.parse(init.body as string)).toEqual({ early: true, skipSweep: true });
      expect(applyStatus).toHaveBeenCalledWith('completed');
    });

    it('surfaces the server error message and does NOT push status on failure', async () => {
      fetchMock.mockResolvedValueOnce(errPost('Not ready to submit'));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.actionError).toBe('Not ready to submit');
      expect(applyStatus).not.toHaveBeenCalled();
    });

    it('falls back to generic copy when the action request throws (network error)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.actionError).toBe('Something went wrong. Please try again.');
      expect(applyStatus).not.toHaveBeenCalled();
    });

    it('falls back to generic copy when the error body is not valid JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      });
      const { result } = renderHook(() =>
        useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
      );
      await act(async () => {
        await result.current.pause();
      });
      expect(result.current.actionError).toBe('Something went wrong. Please try again.');
      expect(applyStatus).not.toHaveBeenCalled();
    });
  });

  it('ignores a second action while one is already in flight (busy guard)', async () => {
    // First action's fetch never resolves within the test → the hook stays busy.
    let resolveFirst!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolveFirst = res;
      })
    );
    const { result } = renderHook(() =>
      useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
    );

    let first!: Promise<void>;
    act(() => {
      first = result.current.pause();
    });
    // busy is now true; a second action must early-return without a second fetch.
    await act(async () => {
      await result.current.resume();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Drain the first action so no act warnings leak.
    await act(async () => {
      resolveFirst(okPost());
      await first;
    });
  });

  it('skips state updates after unmount while an action is in flight', async () => {
    let resolveAction!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolveAction = res;
      })
    );
    const { result, unmount } = renderHook(() =>
      useSessionLifecycle({ sessionId: SESSION_ID, initialView: view(), applyStatus })
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit();
    });
    unmount();
    await act(async () => {
      resolveAction(okPost());
      await pending;
    });

    // The success path's onOk (applyStatus) is guarded by mountedRef → skipped after unmount.
    expect(applyStatus).not.toHaveBeenCalled();
  });

  it('leaves the view null and clears loading when the first-load fetch fails (non-fatal)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(() =>
      useSessionLifecycle({ sessionId: SESSION_ID, accessToken: 'tok-1', applyStatus })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.view).toBeNull();
  });
});
