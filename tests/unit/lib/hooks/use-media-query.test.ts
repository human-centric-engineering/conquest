/**
 * useMediaQuery hook tests
 *
 * The hook is SSR-safe: it returns `false` on the first render, then syncs to
 * `window.matchMedia(query).matches` after mount and re-renders on `change`
 * events. These tests drive a controllable matchMedia stub (jsdom ships none).
 *
 * @see lib/hooks/use-media-query.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

type ChangeListener = (event: MediaQueryListEvent) => void;

function createMatchMedia(initialMatches: boolean) {
  let listeners: ChangeListener[] = [];
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: vi.fn((_type: string, cb: ChangeListener) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn((_type: string, cb: ChangeListener) => {
      listeners = listeners.filter((l) => l !== cb);
    }),
    /** Simulate the viewport crossing the breakpoint. */
    emit(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((l) => l({ matches } as unknown as MediaQueryListEvent));
    },
  };
  return mql;
}

let mql: ReturnType<typeof createMatchMedia>;

beforeEach(() => {
  mql = createMatchMedia(false);
  // Closure reads the live `mql` binding, so a test may swap it before rendering.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql)
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lib/hooks/use-media-query', () => {
  it('syncs to the current match value after mount', () => {
    mql = createMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 639px)'));
    expect(result.current).toBe(true);
  });

  it('returns false when the query does not match', () => {
    const { result } = renderHook(() => useMediaQuery('(max-width: 639px)'));
    expect(result.current).toBe(false);
  });

  it('subscribes with the provided query string', () => {
    renderHook(() => useMediaQuery('(max-width: 639px)'));
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 639px)');
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('re-renders with the new value when the match changes', () => {
    const { result } = renderHook(() => useMediaQuery('(max-width: 639px)'));
    expect(result.current).toBe(false);

    act(() => mql.emit(true));
    expect(result.current).toBe(true);

    act(() => mql.emit(false));
    expect(result.current).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 639px)'));
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
