/**
 * useRespondentReport — hook tests (fetch + token header + terminal-stop).
 *
 * @see lib/hooks/use-respondent-report.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useRespondentReport } from '@/lib/hooks/use-respondent-report';

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRespondentReport', () => {
  it('fetches the report view and exposes it (terminal status → no further poll)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        enabled: true,
        mode: 'raw_plus_insights',
        onScreen: true,
        download: true,
        insights: { status: 'ready', content: null, generatedAt: null, error: null },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRespondentReport('s1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.view?.mode).toBe('raw_plus_insights');
    // A ready report is terminal — exactly one fetch, no polling.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/app/questionnaire-sessions/s1/report');
  });

  it('sends the X-Session-Token header for anonymous respondents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        enabled: false,
        mode: 'raw',
        onScreen: true,
        download: true,
        insights: null,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRespondentReport('s1', 'tok-123'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['X-Session-Token']).toBe('tok-123');
  });

  it('polls while the insights are still generating and stops when ready', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: true,
          mode: 'raw_plus_insights',
          onScreen: true,
          download: true,
          insights: { status: 'queued', content: null, generatedAt: null, error: null },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: true,
          mode: 'raw_plus_insights',
          onScreen: true,
          download: true,
          insights: { status: 'ready', content: null, generatedAt: null, error: null },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRespondentReport('s1'));
    // Flush the initial fetch microtask → it schedules a poll.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Fire the 3s poll → second fetch returns ready → no further poll.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('polls a narrative report while it generates and stops when ready', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: true,
          mode: 'narrative',
          onScreen: true,
          download: true,
          insights: { status: 'processing', content: null, generatedAt: null, error: null },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: true,
          mode: 'narrative',
          onScreen: true,
          download: true,
          insights: { status: 'ready', content: null, generatedAt: null, error: null },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRespondentReport('s1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // processing → schedules a poll
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // ready → terminal
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('stops polling once generation has failed (failed is terminal)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            enabled: true,
            mode: 'raw_plus_insights',
            onScreen: true,
            download: true,
            insights: { status: 'queued', content: null, generatedAt: null, error: null },
          })
        )
        .mockResolvedValue(
          jsonResponse({
            enabled: true,
            mode: 'raw_plus_insights',
            onScreen: true,
            download: true,
            insights: { status: 'failed', content: null, generatedAt: null, error: 'boom' },
          })
        );
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useRespondentReport('s1'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1); // queued → schedules a poll
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchMock).toHaveBeenCalledTimes(2); // failed → terminal, no further poll
      // Polling has stopped, and the timeout fallback never trips on a settled (failed) report.
      await vi.advanceTimersByTimeAsync(6000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current.timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles loaded even when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const { result } = renderHook(() => useRespondentReport('s1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.view).toBeNull();
  });

  it('flags timedOut after exhausting the poll window, and retry resets it', async () => {
    vi.useFakeTimers();
    // Always still generating → the hook keeps polling until it hits the MAX_POLLS cap.
    const queued = jsonResponse({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: { status: 'queued', content: null, generatedAt: null, error: null },
    });
    const fetchMock = vi.fn().mockResolvedValue(queued);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRespondentReport('s1'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0))); // attempt 1
    expect(result.current.timedOut).toBe(false);
    // 59 further polls at 3s → attempt 60 (the cap), after which no poll is scheduled.
    for (let i = 0; i < 60; i++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    }
    expect(result.current.timedOut).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(60);
    // Polling has stopped — advancing further fires nothing.
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(fetchMock).toHaveBeenCalledTimes(60);

    // retry POSTs the retry endpoint (re-queue + kick), then restarts a fresh polling run and clears
    // the timed-out flag: +1 for the POST, +1 for the first GET of the new run = 62.
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.timedOut).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(62);
    // The extra call was the retry POST.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/app/questionnaire-sessions/s1/report/retry',
      expect.objectContaining({ method: 'POST' })
    );

    vi.useRealTimers();
  });
});
