/**
 * `useScopeTabs` (F17.26) — `?tab=` state without an RSC round-trip.
 *
 * Three properties carry the weight, and each is a bug this hook exists to avoid:
 *
 *   1. **The initial value comes from `useSearchParams()`**, so the server render and the first
 *      client render agree. A `window.location` read resolves to the default on the server and to
 *      the real tab on the client, which is a hydration mismatch on the shareable link the hook
 *      exists to serve.
 *   2. **Writes use `history.replaceState`**, not `router.replace` — the latter is a full RSC
 *      round-trip on this route, and can drop the subtree into the parent's Suspense fallback.
 *   3. **`replaceState`, not `pushState`** — a tab is a view of one page, not a place in history.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useScopeTabs } from '@/components/admin/questionnaires/topics/use-scope-tabs';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics');
});

describe('useScopeTabs', () => {
  it('defaults to Topics when the URL says nothing', () => {
    const { result } = renderHook(() => useScopeTabs());
    expect(result.current.activeTab).toBe('topics');
  });

  it('opens on the tab the URL names', () => {
    window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics?tab=rules');
    const { result } = renderHook(() => useScopeTabs());
    expect(result.current.activeTab).toBe('rules');
  });

  it('falls back rather than throwing on a tab nobody recognises', () => {
    window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics?tab=wat');
    const { result } = renderHook(() => useScopeTabs());
    expect(result.current.activeTab).toBe('topics');
  });

  it('writes the tab to the query and keeps the rest of the URL', () => {
    window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics?edit=1');
    const { result } = renderHook(() => useScopeTabs());

    act(() => result.current.setActiveTab('check'));

    const url = new URL(window.location.href);
    expect(url.searchParams.get('tab')).toBe('check');
    expect(url.searchParams.get('edit')).toBe('1');
    expect(url.pathname).toBe('/admin/questionnaires/q1/v/v1/topics');
  });

  it('replaces rather than pushes, so Back does not walk through every tab', () => {
    const push = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useScopeTabs());

    act(() => result.current.setActiveTab('rules'));

    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('follows the Back button', () => {
    const { result } = renderHook(() => useScopeTabs());
    act(() => result.current.setActiveTab('check'));
    expect(result.current.activeTab).toBe('check');

    // The one path that changes the URL without going through `setActiveTab`.
    window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics?tab=rules');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.activeTab).toBe('rules');
  });

  it('stops listening once unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useScopeTabs());

    unmount();

    expect(remove).toHaveBeenCalledWith('popstate', expect.any(Function));
    remove.mockRestore();
  });
});
