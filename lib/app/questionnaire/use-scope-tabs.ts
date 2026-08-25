'use client';

/**
 * `?tab=` state for the Adaptive Scope sub-tabs, without an RSC round-trip (F17.26).
 *
 * ## Why not `useUrlTabs` / `useTrackedUrlTabs`
 *
 * The platform hooks write with `router.replace`. On this route that is a full RSC round-trip —
 * `next.config.js` sets no `staleTimes`, so every tab click would re-run `loadKeyInventory`,
 * `estimateTopicCosts`, `validateAdaptiveScope` and `loadTopicDraft` server-side to render markup
 * that did not change. Worse, `app/admin/questionnaires/[id]/v/[vid]/loading.tsx` exists at the
 * parent segment: if a query-only navigation ever falls into that Suspense fallback the whole
 * subtree unmounts, and with it every piece of state the split exists to preserve — the analyst's
 * in-flight SSE run, the topic editor's unsaved drafts, the preview's result.
 *
 * So the active tab is local state, and the URL is updated with `history.replaceState`, which the
 * App Router does not observe. Same `?tab=` addressability, same shareable link, no refetch.
 *
 * ## Why it lives in the app tier
 *
 * `lib/hooks/use-url-tabs.ts` is Sunrise platform code. Adding a `navigate` option there would be a
 * fork-and-edit that re-conflicts on every upstream sync, for a behaviour only this route needs. If
 * it turns out to be wanted platform-wide, it should be proposed upstream rather than patched here.
 */

import { useCallback, useEffect, useState } from 'react';

import { narrowAdaptiveScopeTab, type AdaptiveScopeTab } from '@/lib/constants/adaptive-scope-tabs';

const PARAM = 'tab';

export interface ScopeTabsState {
  activeTab: AdaptiveScopeTab;
  setActiveTab: (tab: AdaptiveScopeTab) => void;
}

export function useScopeTabs(): ScopeTabsState {
  // Initialised from the URL lazily rather than from `useSearchParams()`. The hook would opt this
  // subtree into client-side rendering during static generation, and the value is only needed
  // once — on mount — which `window.location` answers without that cost.
  const [activeTab, setTab] = useState<AdaptiveScopeTab>(() =>
    typeof window === 'undefined'
      ? narrowAdaptiveScopeTab(null)
      : narrowAdaptiveScopeTab(new URLSearchParams(window.location.search).get(PARAM))
  );

  const setActiveTab = useCallback((tab: AdaptiveScopeTab) => {
    setTab(tab);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, tab);
    // `replaceState`, not `pushState`: a tab is a view of one page, not a place in the admin's
    // history. Pushing would make Back walk them through every tab they looked at before it left
    // the questionnaire, which is not what Back means here.
    window.history.replaceState(window.history.state, '', url);
  }, []);

  // The URL can still change under us — the browser's Back button across a real navigation, or the
  // fork redirect in `topics-panel` carrying `?tab=` to a new version id. Both fire `popstate`.
  useEffect(() => {
    const onPopState = () => {
      setTab(narrowAdaptiveScopeTab(new URLSearchParams(window.location.search).get(PARAM)));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return { activeTab, setActiveTab };
}
