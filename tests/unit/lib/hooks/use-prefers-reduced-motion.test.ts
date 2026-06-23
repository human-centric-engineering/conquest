/**
 * usePrefersReducedMotion — reads `(prefers-reduced-motion: reduce)` and reacts to OS changes.
 *
 * @see lib/hooks/use-prefers-reduced-motion.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';

/** A controllable MediaQueryList stub that records its change listener. */
function installMatchMedia(initialMatches: boolean) {
  let listener: ((e: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn((_: string, cb: (e: MediaQueryListEvent) => void) => {
      listener = cb;
    }),
    removeEventListener: vi.fn(),
  };
  const matchMedia = vi.fn().mockReturnValue(mql);
  // jsdom's window === globalThis, so stubGlobal sets window.matchMedia (what the hook reads).
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    mql,
    matchMedia,
    emit: (matches: boolean) => listener?.({ matches } as MediaQueryListEvent),
  };
}

describe('usePrefersReducedMotion', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reflects the initial match state on mount', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it('returns false when reduced motion is not requested', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('updates when the OS preference changes mid-session', () => {
    const ctl = installMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => ctl.emit(true));
    expect(result.current).toBe(true);
    act(() => ctl.emit(false));
    expect(result.current).toBe(false);
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const ctl = installMatchMedia(false);
    const { unmount } = renderHook(() => usePrefersReducedMotion());
    expect(ctl.mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    unmount();
    expect(ctl.mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('stays false (no throw) when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});
