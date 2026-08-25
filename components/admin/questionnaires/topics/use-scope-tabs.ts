'use client';

/**
 * `?tab=` state for the Conditional Topics sub-tabs, without an RSC round-trip (F17.26).
 *
 * ## Why not `useUrlTabs` / `useTrackedUrlTabs`
 *
 * The platform hooks write with `router.replace`. On this route that is a full RSC round-trip —
 * `next.config.js` sets no `staleTimes`, so every tab click would re-run `loadKeyInventory`,
 * `estimateTopicCosts`, `validateConditionalTopics` and `loadTopicDraft` server-side to render markup
 * that did not change. Worse, `app/admin/questionnaires/[id]/v/[vid]/loading.tsx` exists at the
 * parent segment: if a query-only navigation ever falls into that Suspense fallback the whole
 * subtree unmounts, and with it every piece of state the split exists to preserve — the analyst's
 * in-flight SSE run, the topic editor's unsaved drafts, the preview's result.
 *
 * So the active tab is local state, and the URL is updated with `history.replaceState`. Next
 * patches the history methods, but a `replaceState` that changes only the query does not re-run
 * the server components for this route — which is the property being relied on. Same `?tab=`
 * addressability, same shareable link, no refetch.
 *
 * ## Why it lives here rather than in `lib/`
 *
 * Two reasons, and the second is enforced. `lib/hooks/use-url-tabs.ts` is Sunrise platform code:
 * adding a `navigate` option there would be a fork-and-edit that re-conflicts on every upstream
 * sync, for a behaviour only this route needs. And `lib/app/**` is required to stay
 * framework-agnostic — no runtime `next/*` imports, which ESLint enforces — so a hook that reads
 * `useSearchParams` cannot live there at all. It is a UI hook for one component tree, so it sits
 * with that tree, next to `authoring-mutate.ts` which is a non-component module here for the same
 * reason.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  narrowConditionalTopicsTab,
  type ConditionalTopicsTab,
} from '@/lib/constants/conditional-topics-tabs';

const PARAM = 'tab';

export interface ScopeTabsState {
  activeTab: ConditionalTopicsTab;
  setActiveTab: (tab: ConditionalTopicsTab) => void;
}

export function useScopeTabs(): ScopeTabsState {
  // The initial value comes from `useSearchParams()`, NOT `window.location`.
  //
  // This component is server-rendered — the Topics page is a server component that renders the
  // panel — so a `window`-based initialiser resolves to the default on the server and to the real
  // tab on the client. Radix then emits different `data-state` / `hidden` / `aria-selected` on
  // every trigger and panel between the two passes, which is a hydration mismatch on precisely the
  // shareable `?tab=` link this hook exists to serve.
  //
  // The static-generation cost `useSearchParams` carries does not apply here: this route is
  // dynamic (it awaits `params` and fetches with `no-store`), so it is never prerendered, and the
  // hook returns the real query on the server as well as the client.
  const searchParams = useSearchParams();
  const [activeTab, setTab] = useState<ConditionalTopicsTab>(() =>
    narrowConditionalTopicsTab(searchParams.get(PARAM))
  );

  // No `typeof window` guard: this is only ever reached from an event handler — a tab click or an
  // explainer step — and neither runs during a server render. A guard here would be unreachable
  // code that reads as though the function might be called somewhere it cannot be.
  const setActiveTab = useCallback((tab: ConditionalTopicsTab) => {
    setTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, tab);
    // `replaceState`, not `pushState`: a tab is a view of one page, not a place in the admin's
    // history. Pushing would make Back walk them through every tab they looked at before it left
    // the questionnaire, which is not what Back means here.
    window.history.replaceState(window.history.state, '', url);
  }, []);

  // The browser's Back button is the one path that changes the URL without going through
  // `setActiveTab`, and it is the only thing this listener is for. (The fork redirect in
  // `topics-panel` uses `router.replace`, which does NOT fire `popstate` — it does not need to,
  // because it carries the same `?tab=` forward and the tab is therefore unchanged.)
  useEffect(() => {
    const onPopState = () => {
      setTab(narrowConditionalTopicsTab(new URLSearchParams(window.location.search).get(PARAM)));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return { activeTab, setActiveTab };
}
