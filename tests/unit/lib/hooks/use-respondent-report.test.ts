/**
 * useRespondentReport — hook tests (fetch + token header + terminal-stop).
 *
 * @see lib/hooks/use-respondent-report.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

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

  it('settles loaded even when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const { result } = renderHook(() => useRespondentReport('s1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.view).toBeNull();
  });
});
