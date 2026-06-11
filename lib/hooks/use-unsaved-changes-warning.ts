'use client';

import { useEffect } from 'react';

/**
 * Warn before navigating away while there are unsaved changes.
 *
 * Covers both exit paths the App Router leaves unguarded:
 *  - **Hard nav** (tab close, refresh, address-bar change) via `beforeunload`.
 *  - **Soft nav** (clicking an in-app `<Link>` / `<a>`) via a capture-phase click listener that
 *    `confirm()`s before letting a same-origin navigation proceed.
 *
 * Next.js 16's App Router exposes no `router.events`, so anchor interception is the pragmatic
 * way to guard client-side navigations. New-tab / modified / download / external / same-URL
 * clicks are intentionally left alone.
 *
 * @param enabled  Guard only while this is true (e.g. a `dirty` flag).
 * @param message  Confirm prompt shown on a soft nav (the browser controls the hard-nav copy).
 */
export function useUnsavedChangesWarning(
  enabled: boolean,
  message = 'You have unsaved changes that will be lost. Leave this page anyway?'
): void {
  useEffect(() => {
    if (!enabled) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers require a truthy returnValue to trigger the native prompt.
      event.returnValue = '';
    };

    const onClickCapture = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      // Only plain left-clicks navigate in-page; let the browser handle the rest.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest('a');
      const href = anchor?.getAttribute('href');
      if (!anchor || !href || href.startsWith('#')) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const target = new URL(href, window.location.href);
      if (target.origin !== window.location.origin) return; // external — browser/beforeunload owns it
      if (
        target.pathname === window.location.pathname &&
        target.search === window.location.search
      ) {
        return; // same page (e.g. a no-op link)
      }

      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    // Capture phase so we intercept before Next.js's Link click handler navigates.
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [enabled, message]);
}
