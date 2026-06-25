/**
 * useInlineCorrection — single-shot answer correction behind the "fix this answer" gesture
 * (Variant B). Pins the contract the inline editor depends on but can't easily drive itself:
 * an empty value (including an empty array) PUTs a clear, a save in flight rejects a concurrent
 * submit, an empty batch is a no-op, the signed token rides as `X-Session-Token`, and a non-OK
 * response surfaces the error flag without throwing.
 *
 * @see lib/hooks/use-inline-correction.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useInlineCorrection } from '@/lib/hooks/use-inline-correction';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { ok: 1 } }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The most recent PUT call's parsed body. */
function lastPutBody() {
  const put = [...fetchMock.mock.calls].reverse().find((c) => c[1]?.method === 'PUT');
  return put ? JSON.parse(put[1].body as string) : null;
}

describe('useInlineCorrection', () => {
  it('PUTs a write for a present value and calls onSaved with the refreshed view', async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() => useInlineCorrection({ sessionId: 'sess-1', onSaved }));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit([{ questionKey: 'role', value: 'Engineer' }]);
    });

    expect(ok).toBe(true);
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', value: 'Engineer' }] });
    expect(onSaved).toHaveBeenCalledWith({ ok: 1 });
    expect(result.current.error).toBe(false);
  });

  it('treats an empty string, null, and an empty array as a clear', async () => {
    const { result } = renderHook(() => useInlineCorrection({ sessionId: 'sess-1' }));

    await act(async () => {
      await result.current.submit([
        { questionKey: 'role', value: '  ' },
        { questionKey: 'team', value: null },
        { questionKey: 'tags', value: [] },
      ]);
    });

    expect(lastPutBody()).toEqual({
      answers: [
        { questionKey: 'role', clear: true },
        { questionKey: 'team', clear: true },
        { questionKey: 'tags', clear: true },
      ],
    });
  });

  it('is a no-op that resolves true for an empty batch (no fetch)', async () => {
    const { result } = renderHook(() => useInlineCorrection({ sessionId: 'sess-1' }));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit([]);
    });

    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a concurrent submit while one is already in flight', async () => {
    // Hold the first request open so the second submit observes the in-flight guard.
    let release: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { result } = renderHook(() => useInlineCorrection({ sessionId: 'sess-1' }));

    let firstPromise: Promise<boolean>;
    let secondResult: boolean | undefined;
    await act(async () => {
      firstPromise = result.current.submit([{ questionKey: 'role', value: 'A' }]);
      // Second call lands before the first resolves → guarded out.
      secondResult = await result.current.submit([{ questionKey: 'role', value: 'B' }]);
    });

    expect(secondResult).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: true, json: () => Promise.resolve({ data: {} }) });
      await firstPromise;
    });
  });

  it('forwards a no-login access token as X-Session-Token', async () => {
    const { result } = renderHook(() =>
      useInlineCorrection({ sessionId: 'sess-1', accessToken: 'signed-token' })
    );

    await act(async () => {
      await result.current.submit([{ questionKey: 'role', value: 'Engineer' }]);
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Session-Token']).toBe('signed-token');
  });

  it('sets the error flag and resolves false when the response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useInlineCorrection({ sessionId: 'sess-1', onSaved }));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit([{ questionKey: 'role', value: 'Engineer' }]);
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
